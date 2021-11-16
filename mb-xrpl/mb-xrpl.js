const fs = require('fs');
const { exec } = require("child_process");
const logger = require('./lib/logger');
const { RippleAPIWrapper, EvernodeClient, EvernodeHook, RippleAPIEvents, HookEvents } = require('evernode-js-client');
const { SqliteDatabase, DataTypes } = require('./lib/sqlite-handler');

// Environment variables.
const IS_DEV_MODE = process.env.MB_DEV === "1";
const FILE_LOG_ENABLED = process.env.MB_FILE_LOG === "1";
const IS_DEREGISTER = process.env.MB_DEREGISTER === "1";
const RIPPLED_URL = process.env.MB_RIPPLED_URL || "wss://hooks-testnet.xrpl-labs.com";
const DATA_DIR = process.env.MB_DATA_DIR || __dirname;

const CONFIG_PATH = DATA_DIR + '/mb-xrpl.cfg';
const LOG_PATH = DATA_DIR + '/log/mb-xrpl.log';
const DB_PATH = DATA_DIR + '/mb-xrpl.sqlite';
const DB_TABLE_NAME = 'redeem_ops';
const DB_UTIL_TABLE_NAME = 'util_data';
const LAST_WATCHED_LEDGER = 'last_watched_ledger';
const REDEEM_CREATE_TIMEOUT_THRESHOLD = 0.8;
const REDEEM_WAIT_TIMEOUT_THRESHOLD = 0.4;
const SASHI_CLI_PATH = IS_DEV_MODE ? "../build/sashi" : "/usr/bin/sashi";

const RedeemStatus = {
    REDEEMING: 'Redeeming',
    REDEEMED: 'Redeemed',
    FAILED: 'Failed',
    EXPIRED: 'Expired',
    SASHI_TIMEOUT: 'SashiTimeout',
}

class MessageBoard {
    constructor(configPath, dbPath, sashiCliPath, rippledServer) {
        this.configPath = configPath;
        this.redeemTable = DB_TABLE_NAME;
        this.utilTable = DB_UTIL_TABLE_NAME;
        this.expiryList = [];

        if (!fs.existsSync(this.configPath))
            throw `${this.configPath} does not exist.`;
        else if (!fs.existsSync(sashiCliPath))
            throw `Sashi CLI does not exist in ${sashiCliPath}.`;

        this.sashiCli = new SashiCLI(sashiCliPath);
        this.rippleAPI = new RippleAPIWrapper(rippledServer);
        this.db = new SqliteDatabase(dbPath);
    }

    async init() {
        this.readConfig();
        if (!this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.token || !this.cfg.xrpl.hookAddress)
            throw "Required cfg fields cannot be empty.";

        console.log("Using hook " + this.cfg.xrpl.hookAddress);
        this.evernodeClient = new EvernodeClient(this.cfg.xrpl.address, this.cfg.xrpl.secret, { hookAddress: this.cfg.xrpl.hookAddress })
        this.rippleAPI = this.evernodeClient.rippleAPI;

        try { await this.evernodeClient.connect(); }
        catch (e) { throw e; }

        if (IS_DEREGISTER) {
            await this.deregisterHost();
            this.evernodeClient.disconnect();
            return;
        }

        this.evernodeHook = new EvernodeHook(this.rippleAPI, this.cfg.xrpl.hookAddress);
        this.evernodeHookConf = await this.evernodeHook.getConfig();

        // Check whether registration fee is already paid and trustline is made.
        await this.checkForRegistration();

        this.db.open();
        // Create redeem table if not exist.
        await this.createRedeemTableIfNotExists();
        await this.createUtilDataTableIfNotExists();

        this.lastValidatedLedgerSequence = await this.rippleAPI.ledgerVersion;

        const redeems = await this.getRedeemedRecords();
        for (const redeem of redeems)
            this.addToExpiryList(redeem.tx_hash, redeem.container_name, await this.getExpiryMoment(redeem.created_on_ledger, redeem.h_token_amount));

        this.db.close();

        // Check for instance expiry.
        this.rippleAPI.events.on(RippleAPIEvents.LEDGER, async (e) => {
            this.lastValidatedLedgerSequence = e.ledgerVersion;

            // Filter out instances which needed to be expired and destroy them.
            const currentMoment = await this.evernodeHook.getMoment(e.ledgerVersion);
            const expired = this.expiryList.filter(x => x.expiryMoment < currentMoment);
            if (expired && expired.length) {
                this.expiryList = this.expiryList.filter(x => x.expiryMoment >= currentMoment);

                this.db.open();
                for (const x of expired) {
                    try {
                        console.log(`Moments exceeded (current:${currentMoment}, expiry:${x.expiryMoment}). Destroying ${x.containerName}`);
                        await this.sashiCli.destroyInstance(x.containerName);
                        await this.updateRedeemStatus(x.txHash, RedeemStatus.EXPIRED);
                        console.log(`Destroyed ${x.containerName}`);
                    }
                    catch (e) {
                        console.error(e);
                    }
                }
                this.db.close();
            }
        });

        this.evernodeHook.events.on(HookEvents.Redeem, r => this.handleRedeem(r));

        this.evernodeHook.subscribe();
    }

    async handleRedeem(r) {

        if (r.token !== this.cfg.xrpl.token || r.host !== this.cfg.xrpl.address)
            return;

        this.db.open();

        // Update last watched ledger sequence number.
        await this.updateLastIndexRecord(r.transaction.LastLedgerSequence);

        const txHash = r.transaction.hash;
        const userAddress = r.user;
        const userPubKey = r.transaction.SigningPubKey;
        const amount = parseInt(r.transaction.Amount.value);

        try {
            console.log(`Received redeem from ${userAddress}`);
            await this.createRedeemRecord(txHash, userAddress, amount);

            // The last validated ledger when we receive the redeem request.
            const startingValidatedLedger = this.lastValidatedLedgerSequence;

            // Wait until the sashi cli is available.
            await this.sashiCli.wait();

            // Number of validated ledgers passed while processing the last request.
            let diff = this.lastValidatedLedgerSequence - startingValidatedLedger;
            // Give-up the redeeming porocess if processing the last request takes more than 40% of allowed window.
            let threshold = this.evernodeHookConf.redeemWindow * REDEEM_WAIT_TIMEOUT_THRESHOLD;
            if (diff > threshold) {
                console.error(`Sashimono busy timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                // Update the redeem status of the request to 'SashiTimeout'.
                await this.updateRedeemStatus(txHash, RedeemStatus.SASHI_TIMEOUT);
            }
            else {
                const instanceRequirements = await this.evernodeClient.getRedeemRequirements(r.payload);
                const createRes = await this.sashiCli.createInstance(instanceRequirements);

                // Number of validated ledgers passed while the instance is created.
                diff = this.lastValidatedLedgerSequence - startingValidatedLedger;
                // Give-up the redeeming porocess if the instance creation itself takes more than 80% of allowed window.
                threshold = this.evernodeHookConf.redeemWindow * REDEEM_CREATE_TIMEOUT_THRESHOLD;
                if (diff > threshold) {
                    console.error(`Instance creation timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                    // Update the redeem status of the request to 'SashiTimeout'.
                    await this.updateRedeemStatus(txHash, RedeemStatus.SASHI_TIMEOUT);
                    // Destroy the instance.
                    await this.sashiCli.destroyInstance(createRes.content.name);
                } else {
                    console.log(`Instance created for ${userAddress}`);

                    // Save the value to a local variable to prevent the value being updated between two calls ending up with two different values.
                    const current_ledger_seq = this.lastValidatedLedgerSequence;

                    // Add to in-memory expiry list, so the instance will get destroyed when the moments exceed,
                    this.addToExpiryList(txHash, createRes.content.name, await this.getExpiryMoment(current_ledger_seq, amount));

                    // Update the database for redeemed record.
                    await this.updateRedeemedRecord(txHash, createRes.content.name, current_ledger_seq);

                    // Send the redeem response with created instance info.
                    await this.evernodeClient.redeemSuccess(txHash, userAddress, userPubKey, createRes);
                }
            }
        }
        catch (e) {
            console.error(e);

            // Update the redeem response for failures.
            await this.updateRedeemStatus(txHash, RedeemStatus.FAILED);

            await this.evernodeClient.redeemError(txHash, e.content);
        }

        this.db.close();
    }

    async checkForRegistration() {

        // We assume host account already posseses some EVR balance along with EVR trust line.

        // Make registration fee evernode account.
        if (!this.cfg.xrpl.regFeeHash) {

            // Set the encryption key to be used when sending encrypted redeem requirements (MessageKey account field).
            console.log("Setting message key...");
            if (!await this.evernodeClient.xrplAcc.setMessageKey(this.evernodeClient.accKeyPair.publicKey)) {
                console.log("Failed to set host account message key.");
                return;
            }
            console.log("Host account message key set.");

            console.log(`Performing Evernode host registration...`)

            const tx = await this.evernodeClient.registerHost(this.cfg.xrpl.token, this.cfg.host.instanceSize, this.cfg.host.location)
                .catch(errtx => {
                    console.log("Registration failed.");
                    console.log(errtx);
                });

            if (tx) {
                this.cfg.xrpl.regFeeHash = tx.id;
                this.persistConfig();
                console.log('Registration complete. ' + tx.id);
            }
        }
    }

    async deregisterHost() {
        // Sends evernode host de-registration transaction.
        console.log(`Performing Evernode host deregistration...`);
        const tx = await this.evernodeClient.deregisterHost()
            .catch(errtx => console.log("Deregistration failed."));

        if (tx)
            console.log('Deregistration complete. ' + tx.id);
    }

    addToExpiryList(txHash, containerName, expiryMoment) {
        this.expiryList.push({
            txHash: txHash,
            containerName: containerName,
            expiryMoment: expiryMoment,
        });
        console.log(`Container ${containerName} expiry set at ${expiryMoment}`);
    }

    async createRedeemTableIfNotExists() {
        // Create table if not exists.
        await this.db.createTableIfNotExists(this.redeemTable, [
            { name: 'timestamp', type: DataTypes.INTEGER, notNull: true },
            { name: 'tx_hash', type: DataTypes.TEXT, primary: true, notNull: true },
            { name: 'user_xrp_address', type: DataTypes.TEXT, notNull: true },
            { name: 'h_token_amount', type: DataTypes.INTEGER, notNull: true },
            { name: 'container_name', type: DataTypes.TEXT },
            { name: 'created_on_ledger', type: DataTypes.INTEGER },
            { name: 'status', type: DataTypes.TEXT, notNull: true }
        ]);
    }

    async createUtilDataTableIfNotExists() {
        // Create table if not exists.
        await this.db.createTableIfNotExists(this.utilTable, [
            { name: 'name', type: DataTypes.TEXT, notNull: true },
            { name: 'value', type: DataTypes.INTEGER, notNull: true }
        ]);
        await this.createLastWatchedLedgerEntryIfNotExists();
    }

    async createLastWatchedLedgerEntryIfNotExists() {
        const ret = await this.db.getValues(this.utilTable, { name: LAST_WATCHED_LEDGER });
        if (ret.length === 0) {
            await this.db.insertValue(this.utilTable, { name: LAST_WATCHED_LEDGER, value: -1 });
        }
    }

    async getRedeemedRecords() {
        return (await this.db.getValues(this.redeemTable, { status: RedeemStatus.REDEEMED }));
    }

    async createRedeemRecord(txHash, txUserAddress, txAmount) {
        await this.db.insertValue(this.redeemTable, {
            timestamp: Date.now(),
            tx_hash: txHash,
            user_xrp_address: txUserAddress,
            h_token_amount: txAmount,
            status: RedeemStatus.REDEEMING
        });
    }

    async updateLastIndexRecord(ledger_idx) {
        await this.db.updateValue(this.utilTable, {
            value: ledger_idx,
        }, { name: LAST_WATCHED_LEDGER });
    }

    async updateRedeemedRecord(txHash, containerName, ledgerVersion) {
        await this.db.updateValue(this.redeemTable, {
            container_name: containerName,
            created_on_ledger: ledgerVersion,
            status: RedeemStatus.REDEEMED
        }, { tx_hash: txHash });
    }

    async updateRedeemStatus(txHash, status) {
        await this.db.updateValue(this.redeemTable, { status: status }, { tx_hash: txHash });
    }

    async getExpiryMoment(createdOnLedger, moments) {
        return (await this.evernodeHook.getMoment(createdOnLedger)) + moments;
    }

    readConfig() {
        this.cfg = JSON.parse(fs.readFileSync(this.configPath).toString());
    }

    persistConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
    }

    async getMissedPaymentTransactions(lastWatchedLedger) {
        return await this.rippleAPI.api.getTransactions(this.cfg.xrpl.hookAddress, {
            excludeFailures: true,
            minLedgerVersion: lastWatchedLedger,
            types: [RippleAPIEvents.PAYMENT]
        });
    }
}

class SashiCLI {

    #waiting = false;

    constructor(cliPath) {
        this.cliPath = cliPath;
    }

    async createInstance(requirements) {
        if (!requirements.type)
            requirements.type = 'create';

        const res = await this.execSashiCli(requirements);
        if (res.type === 'create_error')
            throw res;

        return res;
    }

    async destroyInstance(containerName) {
        const msg = {
            type: 'destroy',
            container_name: containerName
        };
        const res = await this.execSashiCli(msg);
        if (res.content && typeof res.content == 'string' && res.content.endsWith("error"))
            throw res;

        return res;
    }

    wait() {
        return new Promise(resolve => {
            // Wait until waiting sashi cli requests are completed..
            let waitCheck = setInterval(() => {
                if (!this.#waiting) {
                    clearInterval(waitCheck);
                    resolve(true);
                }
            }, 100);
        })
    }

    execSashiCli(msg) {
        this.#waiting = true;
        return new Promise((resolve, reject) => {
            exec(`${this.cliPath} json -m '${JSON.stringify(msg)}'`, { stdio: 'pipe' }, (err, stdout, stderr) => {
                this.#waiting = false;

                if (err || stderr) {
                    reject(err || stderr);
                    return;
                }

                let message = Buffer.from(stdout).toString();
                resolve(JSON.parse(message.substring(0, message.length - 1))); // Skipping the \n from the result.
            });
        })
    }

    checkStatus() {
        this.#waiting = true;
        return new Promise((resolve, reject) => {
            exec(`${this.cliPath} status`, { stdio: 'pipe' }, (err, stdout, stderr) => {
                this.#waiting = false;

                if (err || stderr) {
                    reject(err || stderr);
                    return;
                }

                let message = Buffer.from(stdout).toString();
                message = message.substring(0, message.length - 1); // Skipping the \n from the result.
                console.log(`Sashi CLI : ${message}`);
                resolve(message);
            });
        });
    }
}

async function main() {

    // Logs are formatted with the timestamp and a log file will be created inside log directory.
    logger.init(LOG_PATH, FILE_LOG_ENABLED);

    console.log('Starting the Evernode xrpl message board.' + (IS_DEV_MODE ? ' (in dev mode)' : ''));
    console.log('Data dir: ' + DATA_DIR);
    console.log('Rippled server: ' + RIPPLED_URL);
    console.log('Using Sashimono cli: ' + SASHI_CLI_PATH);

    const mb = new MessageBoard(CONFIG_PATH, DB_PATH, SASHI_CLI_PATH, RIPPLED_URL);
    await mb.init();
}

main().catch(console.error);