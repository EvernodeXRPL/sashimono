const fs = require('fs');
const { exec } = require("child_process");
const logger = require('./lib/logger');
const { XrplAccount, RippleAPIWrapper, EvernodeHook, RippleAPIEvents, RippleConstants, MemoFormats, MemoTypes, ErrorCodes, EncryptionHelper } = require('evernode-js-client');
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
const EVR_CUR_CODE = 'EVR';
const REDEEM_TIMEOUT_THRESHOLD = 0.8;
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

        try { await this.rippleAPI.connect(); }
        catch (e) { throw e; }

        this.xrplAcc = new XrplAccount(this.rippleAPI, this.cfg.xrpl.address, this.cfg.xrpl.secret);
        this.accKeyPair = this.xrplAcc.deriveKeypair();

        if (IS_DEREGISTER) {
            await this.deregisterHost();
            this.rippleAPI.disconnect();
            return;
        }

        this.evernodeXrplAcc = new XrplAccount(this.rippleAPI, this.cfg.xrpl.hookAddress);

        await this.initHookConfigValues();

        // Check whether registration fee is already payed and trustline is made.
        await this.checkForRegistration();

        this.db.open();
        // Create redeem table if not exist.
        await this.createRedeemTableIfNotExists();
        await this.createUtilDataTableIfNotExists();

        this.lastValidatedLedgerSequence = await this.rippleAPI.ledgerVersion;

        const redeems = await this.getRedeemedRecords();
        for (const redeem of redeems)
            this.addToExpiryList(redeem.tx_hash, redeem.container_name, this.getExpiryLedger(redeem.created_on_ledger, redeem.h_token_amount));

        this.db.close();

        // Check for instance expiry.
        this.rippleAPI.events.on(RippleAPIEvents.LEDGER, async (e) => {
            this.lastValidatedLedgerSequence = e.ledgerVersion;

            // Filter out instances which needed to be expired and destroy them.
            const expired = this.expiryList.filter(x => x.expiryLedger <= e.ledgerVersion);
            if (expired && expired.length) {
                this.expiryList = this.expiryList.filter(x => x.expiryLedger > e.ledgerVersion);

                this.db.open();
                for (const x of expired) {
                    try {
                        console.log(`Moments exceeded. Destroying ${x.containerName}`);
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

        // Handle the transactions on evernode account and filter out redeem operations.
        this.evernodeXrplAcc.events.on(RippleAPIEvents.PAYMENT, async (data, error) => {
            if (error)
                console.error(error);
            else if (!data)
                console.log('Invalid transaction.');
            else if (data) {
                this.db.open();
                // Update last watched ledger sequence number regardless the transaction is redeem or not.
                await this.updateLastIndexRecord(data.LastLedgerSequence);

                if (this.isRedeem(data)) {
                    const txHash = data.hash;
                    const txAccount = data.Account;
                    const txPubKey = data.SigningPubKey;
                    const amount = parseInt(data.Amount.value);
                    // Filter the memo feilds with redeem type and binary format.
                    const memos = data.Memos.filter(m => m.data && m.type === MemoTypes.REDEEM && m.format === MemoFormats.BINARY);

                    for (let memo of memos) {

                        try {
                            console.log(`Received redeem from ${txAccount}`);
                            await this.createRedeemRecord(txHash, txAccount, amount);

                            // The last validated ledger when we receive the redeem request.
                            const startingValidatedLedger = this.lastValidatedLedgerSequence;

                            // Decrypt redeem requirements using the decryption key derived from host secret.
                            const instanceRequirements = await EncryptionHelper.decrypt(this.accKeyPair.privateKey, memo.data);
                            if (!instanceRequirements) {
                                console.log('Failed to decrypt redeem data.');
                                break;
                            }

                            const createRes = await this.sashiCli.createInstance(instanceRequirements);

                            // Number of validated ledgers passed while the instance is created.
                            const diff = this.lastValidatedLedgerSequence - startingValidatedLedger;

                            // Give-up the redeeming porocess if the instance creation itself takes more than 80% of allowed window.
                            const threshold = this.evernodeHookConf.redeemWindow * REDEEM_TIMEOUT_THRESHOLD;
                            if (diff > threshold) {
                                console.error(`Instance creation timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                                // Update the redeem status of the request to 'SashiTimeout'.
                                await this.updateRedeemStatus(txHash, RedeemStatus.SASHI_TIMEOUT);
                                // Destroy the instance.
                                await this.sashiCli.destroyInstance(createRes.content.name);
                            } else {
                                console.log(`Instance created for ${txAccount}`);
                                // Send the redeem response with created instance info.
                                const data = await this.sendRedeemResponse(txHash, txPubKey, txAccount, createRes);

                                // Save the value to a local variable to prevent the value being updated between two calls ending up with two different values.
                                const current_ledger_seq = this.lastValidatedLedgerSequence;
                                // Add to in-memory expiry list, so the instance will get destroyed when the moments exceed,
                                this.addToExpiryList(txHash, createRes.content.name, this.getExpiryLedger(current_ledger_seq, amount));
                                // Update the database for redeemed record.
                                await this.updateRedeemedRecord(txHash, createRes.content.name, current_ledger_seq);
                            }
                        }
                        catch (e) {
                            console.error(e);
                            await this.sendRedeemResponse(txHash, txPubKey, txAccount, { type: ErrorCodes.REDEEM_ERR, reason: e.content ? e.content : undefined }, true);
                            // Update the redeem response for failures.
                            await this.updateRedeemStatus(txHash, RedeemStatus.FAILED);
                        }
                    }
                }
                this.db.close();
            }
        });
        this.evernodeXrplAcc.subscribe();
    }

    async initHookConfigValues() {
        this.evernodeHook = new EvernodeHook(this.evernodeXrplAcc);
        this.evernodeHookConf = await this.evernodeHook.getConfig();

        console.log('Hook state configurations are loaded.');
        console.log(JSON.stringify(this.evernodeHookConf).replace('\\', ''));
    }

    isRedeem(transaction) {
        // Check whether an issued currency.
        const isIssuedCurrency = (typeof transaction.Amount === "object");
        // Check whether an incomming transaction to the hook.
        const isToHook = transaction.Destination === this.cfg.xrpl.hookAddress;
        if (isIssuedCurrency && isToHook) {
            const token = transaction.Amount.currency;
            const issuer = transaction.Amount.issuer;
            return (token === this.cfg.xrpl.token && issuer === this.cfg.xrpl.address && transaction.Memos && transaction.Memos.length);
        }
        return false;
    }

    async checkForRegistration() {

        // We assume host account already posseses some EVR balance along with EVR trust line.

        // Make registration fee evernode account.
        if (!this.cfg.xrpl.regFeeHash) {
            const memoData = `${this.cfg.xrpl.token};${this.cfg.host.instanceSize};${this.cfg.host.location}`
            // For now we comment EVR reg fee transaction and make XRP transaction instead.
            console.log(`Making Evernode host registration payment of ${this.evernodeHookConf.hostRegFee} ${EVR_CUR_CODE}...`)
            const res = await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
                this.evernodeHookConf.hostRegFee.toString(),
                EVR_CUR_CODE,
                this.cfg.xrpl.hookAddress,
                [{ type: MemoTypes.HOST_REG, format: MemoFormats.TEXT, data: memoData }]);
            if (res) {
                this.cfg.xrpl.regFeeHash = res.txHash;
                this.persistConfig();
                console.log('Registration payment made for evernode account.');

                // Set the encryption key to be used when sending encrypted redeem requirements (MessageKey account field).
                console.log("Setting message key...");
                if (await this.xrplAcc.setMessageKey(this.accKeyPair.publicKey))
                    console.log("Host account message key set.");
                else
                    console.log("Failed to set host account message key.");
            }
            else {
                console.log("Registration payment failed.");
            }
        }
    }

    async deregisterHost() {
        // Sends evernode host de-registration transaction.
        console.log(`Performing Evernode host deregistration...`);
        const res = await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
            RippleConstants.MIN_XRP_AMOUNT,
            "XRP",
            null,
            [{ type: MemoTypes.HOST_DEREG, format: MemoFormats.TEXT, data: "" }]);
        if (res)
            console.log('Deregistration complete.');
    }

    async sendRedeemResponse(txHash, txPubkey, txAccount, response, isError = false) {
        // Verifying the pubkey.
        if (!(await this.rippleAPI.isValidKeyForAddress(txPubkey, txAccount)))
            throw 'Invalid public key for redeem response encryption.';

        let memos = [{ type: MemoTypes.REDEEM_REF, format: MemoFormats.BINARY, data: txHash }];
        if (isError) {
            // Send redeem response with error.
            memos.push({ type: MemoTypes.REDEEM_RESP, format: MemoFormats.JSON, data: response });
        } else {
            // Encrypt response with user pubkey.
            response = await EncryptionHelper.encrypt(txPubkey, response);
            memos.push({ type: MemoTypes.REDEEM_RESP, format: MemoFormats.BINARY, data: response });
        }

        return (await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
            RippleConstants.MIN_XRP_AMOUNT,
            "XRP",
            null,
            memos));
    }

    addToExpiryList(txHash, containerName, expiryLedger) {
        this.expiryList.push({
            txHash: txHash,
            containerName: containerName,
            expiryLedger: expiryLedger,
        });
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

    getExpiryLedger(createdOnLedger, moments) {
        return createdOnLedger + (moments * this.evernodeHookConf.momentSize);
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

    execSashiCli(msg) {
        return new Promise((resolve, reject) => {
            exec(`${this.cliPath} json -m '${JSON.stringify(msg)}'`, { stdio: 'pipe' }, (err, stdout, stderr) => {
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
        return new Promise((resolve, reject) => {
            exec(`${this.cliPath} status`, { stdio: 'pipe' }, (err, stdout, stderr) => {
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