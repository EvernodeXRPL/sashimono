const fs = require('fs');
const process = require('process');
const { Buffer } = require('buffer');
const { exec } = require("child_process");
const logger = require('./lib/logger');
const evernode = require('evernode-js-client');
const { SqliteDatabase, DataTypes } = require('./lib/sqlite-handler');
const https = require('https');

// Environment variables.
const IS_DEV_MODE = process.env.MB_DEV === "1";
const FILE_LOG_ENABLED = process.env.MB_FILE_LOG === "1";
const RIPPLED_URL = process.env.MB_RIPPLED_URL || "wss://hooks-testnet.xrpl-labs.com";
const DATA_DIR = process.env.MB_DATA_DIR || __dirname;
const FAUCET_URL = process.env.MB_FAUCET_URL || "https://hooks-testnet.xrpl-labs.com/newcreds"
const EVR_SEND_URL = process.env.MB_EVR_SEND_URL || "https://func-hotpocket.azurewebsites.net/api/evrfaucet?code=pPUyV1q838ryrihA5NVlobVXj8ZGgn9HsQjGGjl6Vhgxlfha4/xCgQ==&action=fundhost&hostaddr="

const CONFIG_PATH = DATA_DIR + '/mb-xrpl.cfg';
const LOG_PATH = DATA_DIR + '/log/mb-xrpl.log';
const DB_PATH = DATA_DIR + '/mb-xrpl.sqlite';
const DB_TABLE_NAME = 'redeem_ops';
const DB_UTIL_TABLE_NAME = 'util_data';
const LAST_WATCHED_LEDGER = 'last_watched_ledger';
const REDEEM_CREATE_TIMEOUT_THRESHOLD = 0.8;
const REDEEM_WAIT_TIMEOUT_THRESHOLD = 0.4;
const SASHI_CLI_PATH = IS_DEV_MODE ? "../build/sashi" : "/usr/bin/sashi";
const MB_VERSION = '1.0.0';

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
        this.rippledServer = rippledServer;
        this.lastRechargedMoment = null;

        if (!fs.existsSync(sashiCliPath))
            throw `Sashi CLI does not exist in ${sashiCliPath}.`;

        this.sashiCli = new SashiCLI(sashiCliPath);
        this.db = new SqliteDatabase(dbPath);
    }

    async init() {
        if (!fs.existsSync(this.configPath))
            throw `${this.configPath} does not exist.`;

        this.readConfig();
        if (!this.cfg.version || !this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.token || !this.cfg.xrpl.hookAddress)
            throw "Required cfg fields cannot be empty.";

        console.log("Using hook " + this.cfg.xrpl.hookAddress);

        this.xrplApi = new evernode.XrplApi(this.rippledServer);
        evernode.Defaults.set({
            hookAddress: this.cfg.xrpl.hookAddress,
            rippledServer: this.rippledServer,
            xrplApi: this.xrplApi
        })
        await this.xrplApi.connect();

        this.hostClient = new evernode.HostClient(this.cfg.xrpl.address, this.cfg.xrpl.secret);
        await this.hostClient.connect();
        this.evernodeHookConf = this.hostClient.hookConfig;

        this.hookClient = new evernode.HookClient();
        await this.hookClient.connect();

        this.db.open();
        // Create redeem table if not exist.
        await this.createRedeemTableIfNotExists();
        await this.createUtilDataTableIfNotExists();

        this.lastValidatedLedgerIndex = this.xrplApi.ledgerIndex;

        const redeems = await this.getRedeemedRecords();
        for (const redeem of redeems)
            this.addToExpiryList(redeem.tx_hash, redeem.container_name, await this.getExpiryMoment(redeem.created_on_ledger, redeem.h_token_amount));

        this.db.close();

        // Check for instance expiry.
        this.xrplApi.on(evernode.XrplApiEvents.LEDGER, async (e) => {
            this.lastValidatedLedgerIndex = e.ledger_index;

            const currentMoment = await this.hookClient.getMoment(e.ledger_index);
            // Sending recharges every CONF_HOST_HEARTBEAT_FREQ moments.
            if (currentMoment % this.hostClient.hookConfig.hostHeartbeatFreq === 0 && currentMoment !== this.lastRechargedMoment) {
                this.lastRechargedMoment = currentMoment;

                console.log(`Recharging at Moment ${this.lastRechargedMoment}...`)

                try {
                    await this.hostClient.recharge();
                    console.log(`Recharge successful at Moment ${this.lastRechargedMoment}.`);
                }
                catch (err) {
                    if (err.code === 'tecHOOK_REJECTED')
                        console.log("Recarge rejected by the hook.");
                    else
                        console.log("Recharge tx error", err);
                }
            }

            // Filter out instances which needed to be expired and destroy them.
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

        this.hostClient.on(evernode.HostEvents.Redeem, r => this.handleRedeem(r));
    }

    async handleRedeem(r) {

        if (r.token !== this.cfg.xrpl.token || r.host !== this.cfg.xrpl.address)
            return;

        this.db.open();

        // Update last watched ledger sequence number.
        await this.updateLastIndexRecord(r.transaction.LastLedgerSequence);

        const redeemRefId = r.redeemRefId; // Redeem tx hash.
        const userAddress = r.user;
        const amount = r.moments;

        try {
            console.log(`Received redeem from ${userAddress}`);
            await this.createRedeemRecord(redeemRefId, userAddress, amount);

            // The last validated ledger when we receive the redeem request.
            const startingValidatedLedger = this.lastValidatedLedgerIndex;

            // Wait until the sashi cli is available.
            await this.sashiCli.wait();

            // Number of validated ledgers passed while processing the last request.
            let diff = this.lastValidatedLedgerIndex - startingValidatedLedger;
            // Give-up the redeeming porocess if processing the last request takes more than 40% of allowed window.
            let threshold = this.evernodeHookConf.redeemWindow * REDEEM_WAIT_TIMEOUT_THRESHOLD;
            if (diff > threshold) {
                console.error(`Sashimono busy timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                // Update the redeem status of the request to 'SashiTimeout'.
                await this.updateRedeemStatus(redeemRefId, RedeemStatus.SASHI_TIMEOUT);
            }
            else {
                const instanceRequirements = r.payload;
                const createRes = await this.sashiCli.createInstance(instanceRequirements);

                // Number of validated ledgers passed while the instance is created.
                diff = this.lastValidatedLedgerIndex - startingValidatedLedger;
                // Give-up the redeeming porocess if the instance creation itself takes more than 80% of allowed window.
                threshold = this.evernodeHookConf.redeemWindow * REDEEM_CREATE_TIMEOUT_THRESHOLD;
                if (diff > threshold) {
                    console.error(`Instance creation timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                    // Update the redeem status of the request to 'SashiTimeout'.
                    await this.updateRedeemStatus(redeemRefId, RedeemStatus.SASHI_TIMEOUT);
                    // Destroy the instance.
                    await this.sashiCli.destroyInstance(createRes.content.name);
                } else {
                    console.log(`Instance created for ${userAddress}`);

                    // Save the value to a local variable to prevent the value being updated between two calls ending up with two different values.
                    const currentLedgerIndex = this.lastValidatedLedgerIndex;

                    // Add to in-memory expiry list, so the instance will get destroyed when the moments exceed,
                    this.addToExpiryList(redeemRefId, createRes.content.name, await this.getExpiryMoment(currentLedgerIndex, amount));

                    // Update the database for redeemed record.
                    await this.updateRedeemedRecord(redeemRefId, createRes.content.name, currentLedgerIndex);

                    // Send the redeem response with created instance info.
                    await this.hostClient.redeemSuccess(redeemRefId, userAddress, createRes);
                }
            }
        }
        catch (e) {
            console.error(e);

            // Update the redeem response for failures.
            await this.updateRedeemStatus(redeemRefId, RedeemStatus.FAILED);

            await this.hostClient.redeemError(redeemRefId, e.content);
        }

        this.db.close();
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

    async updateRedeemedRecord(txHash, containerName, ledgerIndex) {
        await this.db.updateValue(this.redeemTable, {
            container_name: containerName,
            created_on_ledger: ledgerIndex,
            status: RedeemStatus.REDEEMED
        }, { tx_hash: txHash });
    }

    async updateRedeemStatus(txHash, status) {
        await this.db.updateValue(this.redeemTable, { status: status }, { tx_hash: txHash });
    }

    async getExpiryMoment(createdOnLedger, moments) {
        return (await this.hookClient.getMoment(createdOnLedger)) + moments;
    }

    readConfig() {
        this.cfg = JSON.parse(fs.readFileSync(this.configPath).toString());
    }

    persistConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
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
            // Wait until incompleted sashi cli requests are completed..
            const waitCheck = setInterval(() => {
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

class Setup {

    #httpPost(url) {
        return new Promise((resolve, reject) => {
            const req = https.request(url, { method: 'POST' }, (resp) => {
                let data = '';
                resp.on('data', (chunk) => data += chunk);
                resp.on('end', () => {
                    if (resp.statusCode == 200)
                        resolve(data);
                    else
                        reject(data);
                });
            })

            req.on("error", reject);
            req.on('timeout', () => reject('Request timed out.'))
            req.end()
        })
    }

    async #generateFaucetAccount() {
        console.log("Generating faucet account...");
        const resp = await this.#httpPost(FAUCET_URL);
        const json = JSON.parse(resp);
        return {
            address: json.address,
            secret: json.secret
        };
    }

    #getRandomToken() {
        const randomChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let result = '';
        for (var i = 0; i < 3; i++) {
            result += randomChars.charAt(Math.floor(Math.random() * randomChars.length));
        }
        return result;
    }

    #getConfigAccount() {
        if (!fs.existsSync(CONFIG_PATH))
            throw `Config file does not exist at ${CONFIG_PATH}`;
        return JSON.parse(fs.readFileSync(CONFIG_PATH).toString()).xrpl;
    }

    async #sendEversFromHook(hostAddress) {
        console.log("Sending EVRs...");

        // Sometimes we may get error from func execution when some rippled servers in the testnet cluster
        // haven't still updated the ledger. In such cases, we retry several times before giving up.
        let attempts = 0;
        while (attempts >= 0) {
            try {
                await this.#httpPost(EVR_SEND_URL + hostAddress);
                break;
            }
            catch (err) {
                if (++attempts <= 5)
                    continue;

                throw err;
            }
        }
    }

    async generateBetaHostAccount(hookAddress) {

        evernode.Defaults.set({
            hookAddress: hookAddress,
            rippledServer: RIPPLED_URL
        });

        const acc = await this.#generateFaucetAccount();
        acc.token = this.#getRandomToken();

        // Prepare host account.
        {
            console.log(`Preparing host account:${acc.address} (token:${acc.token} hook:${hookAddress})`);
            const hostClient = new evernode.HostClient(acc.address, acc.secret);
            await hostClient.connect();

            // Sometimes we may get 'account not found' error from rippled when some servers in the testnet cluster
            // haven't still updated the ledger. In such cases, we retry several times before giving up.
            let attempts = 0;
            while (attempts >= 0) {
                try {
                    await hostClient.prepareAccount();
                    break;
                }
                catch (err) {
                    if (err.data.error === 'actNotFound' && ++attempts <= 5) {
                        console.log("actNotFound - retrying...")
                        // Wait and retry.
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    }
                    throw err;
                }
            }

            await hostClient.disconnect();
        }

        // Send EVRs from hook to host account.
        {
            await this.#sendEversFromHook(acc.address);
        }

        return acc;
    }

    newConfig(address = "", secret = "", hookAddress = "", token = "") {
        if (fs.existsSync(CONFIG_PATH))
            throw `Config file already exists at ${CONFIG_PATH}`;

        const configJson = JSON.stringify({
            version: MB_VERSION,
            xrpl: { address: address, secret: secret, hookAddress: hookAddress, token: token }
        }, null, 2);
        fs.writeFileSync(CONFIG_PATH, configJson, { mode: 0o600 }); // Set file permission so only current user can read/write.
    }

    async register(countryCode, cpuMicroSec, ramKb, swapKb, diskKb, description) {
        console.log("Registering host...");
        const acc = this.#getConfigAccount();
        evernode.Defaults.set({
            hookAddress: acc.hookAddress,
            rippledServer: RIPPLED_URL
        });

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Sometimes we may get 'tecPATH_DRY' error from rippled when some servers in the testnet cluster
        // haven't still updated the ledger. In such cases, we retry several times before giving up.
        let attempts = 0;
        while (attempts >= 0) {
            try {
                await hostClient.register(acc.token, countryCode, cpuMicroSec,
                    Math.floor((ramKb + swapKb) / 1024), Math.floor(diskKb / 1024), description.replace('_', ' '));
                break;
            }
            catch (err) {
                if (err.code === 'tecPATH_DRY' && ++attempts <= 5) {
                    console.log("tecPATH_DRY - retrying...")
                    // Wait and retry.
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    continue;
                }
                throw err;
            }
        }

        await hostClient.disconnect();
    }

    async deregister() {
        console.log("Deregistering host...");
        const acc = this.#getConfigAccount();
        evernode.Defaults.set({
            hookAddress: acc.hookAddress,
            rippledServer: RIPPLED_URL
        });

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();
        await hostClient.deregister();
        await hostClient.disconnect();
    }

    async regInfo() {
        const acc = this.#getConfigAccount();
        evernode.Defaults.set({
            hookAddress: acc.hookAddress,
            rippledServer: RIPPLED_URL
        });

        console.log(`Host account address: ${acc.address}`);
        console.log(`Hosting token: ${acc.token}`);
        try {
            const hostClient = new evernode.HostClient(acc.address, acc.secret);
            console.log('Retrieving EVR balance...')
            await hostClient.connect();
            const evrBalance = await hostClient.getEVRBalance();
            console.log(`EVR balance: ${evrBalance}`);
            await hostClient.disconnect();
        }
        catch {
            console.log('EVR balance: [Error occured when retrieving EVR balance]');
        }
        console.log(`Hook address: ${acc.hookAddress}`);
    }
}

async function main() {

    if (process.argv[2] === 'version') {
        console.log(MB_VERSION);
    }

    try {
        if (process.argv.length >= 3) {
            if (process.argv.length >= 3 && process.argv[2] === 'new') {
                new Setup().newConfig(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
            }
            else if (process.argv.length === 4 && process.argv[2] === 'betagen') {
                const hookAddress = process.argv[3];
                const setup = new Setup();
                const acc = await setup.generateBetaHostAccount(hookAddress);
                setup.newConfig(acc.address, acc.secret, hookAddress, acc.token);
            }
            else if (process.argv.length === 9 && process.argv[2] === 'register') {
                await new Setup().register(process.argv[3], parseInt(process.argv[4]), parseInt(process.argv[5]),
                    parseInt(process.argv[6]), parseInt(process.argv[7]), process.argv[8]);
            }
            else if (process.argv.length === 3 && process.argv[2] === 'deregister') {
                await new Setup().deregister();
            }
            else if (process.argv.length === 3 && process.argv[2] === 'reginfo') {
                await new Setup().regInfo();
            }
            else if (process.argv[2] === 'help') {
                console.log(`Usage:
        node index.js - Run message board.
        node index.js version - Print version.
        node index.js new [address] [secret] [hookAddress] [token] - Create new config file.
        node index.js betagen [hookAddress] - Generate beta host account and populate config.
        node index.js register [countryCode] [cpuMicroSec] [ramKb] [swapKb] [diskKb] [description] - Register the host on Evernode.
        node index.js deregister - Deregister the host from Evernode.
        node index.js reginfo - Display Evernode registration info.
        node index.js help - Print help.`);
            }
            else {
                throw "Invalid args.";
            }
        }
        else {
            // Logs are formatted with the timestamp and a log file will be created inside log directory.
            logger.init(LOG_PATH, FILE_LOG_ENABLED);

            console.log('Starting the Evernode xrpl message board.' + (IS_DEV_MODE ? ' (in dev mode)' : ''));
            console.log('Data dir: ' + DATA_DIR);
            console.log('Rippled server: ' + RIPPLED_URL);
            console.log('Using Sashimono cli: ' + SASHI_CLI_PATH);

            const mb = new MessageBoard(CONFIG_PATH, DB_PATH, SASHI_CLI_PATH, RIPPLED_URL);
            await mb.init();
        }

    }
    catch (err) {
        console.log(err);
        console.log("Evernode xrpl message board exiting with error.");
        process.exit(1);
    }
}

main().catch(console.error);