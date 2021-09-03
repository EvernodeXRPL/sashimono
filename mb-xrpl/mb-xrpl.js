const fs = require('fs');
const { exec } = require("child_process");
const logger = require('./lib/logger');
const { XrplAccount, RippleAPIWarpper, Events, MemoFormats, MemoTypes, EncryptionHelper } = require('./lib/ripple-handler');
const { SqliteDatabase, DataTypes } = require('./lib/sqlite-handler');

const CONFIG_PATH = 'mb-xrpl.cfg';
const DB_PATH = 'mb-xrpl.sqlite';
const DB_TABLE_NAME = 'redeem_ops';
const EVR_CUR_CODE = 'EVR';
const EVR_LIMIT = 99999999;
const REG_FEE = 5;
const RES_FEE = 0.000001;
const LEDGERS_PER_MOMENT = 72;

const RedeemStatus = {
    REDEEMING: 'Redeeming',
    REDEEMED: 'Redeemed',
    FAILED: 'Failed',
    EXPIRED: 'Expired'
}

const SASHI_CLI_PATH_DEV = "../build/sashi";
const SASHI_CLI_PATH_PROD = "/usr/bin/sashi";

const hexToASCII = (hex) => {
    let str = "";
    for (let n = 0; n < hex.length; n += 2) {
        str += String.fromCharCode(parseInt(hex.substr(n, 2), 16));
    }
    return str;
}

class MessageBoard {
    constructor(configPath, dbPath, sashiCliPath, rippleServer) {
        this.configPath = configPath;
        this.redeemTable = DB_TABLE_NAME;
        this.expiryList = [];

        if (!fs.existsSync(this.configPath))
            throw `${this.configPath} does not exist.`;
        else if (!fs.existsSync(sashiCliPath))
            throw `Sashi CLI does not exist in ${sashiCliPath}.`;

        this.sashiCli = new SashiCLI(sashiCliPath);
        this.ripplAPI = new RippleAPIWarpper(rippleServer);
        this.db = new SqliteDatabase(dbPath);
    }

    async init() {
        this.readConfig();

        if (!this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.token || !this.cfg.xrpl.hookAddress)
            throw "Required cfg fields cannot be empty.";


        try { await this.ripplAPI.connect(); }
        catch (e) { throw e; }

        this.db.open();
        // Create redeem table if not exist.
        await this.createRedeemTableIfNotExists();

        const redeems = await this.getRedeemedRecords();
        for (const redeem of redeems)
            this.addToExpiryList(redeem.tx_hash, redeem.container_name, this.getExpiryLedger(redeem.created_on_ledger, redeem.h_token_amount));

        this.db.close();

        // Check fo instance expiry.
        this.ripplAPI.events.on(Events.LEDGER, async (e) => {
            const expired = this.expiryList.filter(x => x.expiryLedger <= e.ledgerVersion);
            if (expired && expired.length) {
                this.expiryList = this.expiryList.filter(x => x.expiryLedger > e.ledgerVersion);

                this.db.open();
                for (const x of expired) {
                    console.log(`Moments exceeded. Destroying ${x.containerName}`);
                    await this.sashiCli.destroyInstance(x.containerName);
                    await this.updateRedeemStatus(x.txHash, RedeemStatus.EXPIRED);
                    console.log(`Destroyed ${x.containerName}`);
                }
                this.db.close();
            }


        });

        this.xrplAcc = new XrplAccount(this.ripplAPI.api, this.cfg.xrpl.address, this.cfg.xrpl.secret);

        await this.checkForRegistration();

        this.evernodeXrplAcc = new XrplAccount(this.ripplAPI.api, this.cfg.xrpl.hookAddress);

        this.evernodeXrplAcc.events.on(Events.PAYMENT, async (data, error) => {
            if (data) {
                // Check whether issued currency
                const isIssuedCurrency = (typeof data.Amount === "object");
                // Check whether incomming to hook.
                const isToHook = data.Destination === this.cfg.xrpl.hookAddress;
                if (isIssuedCurrency && isToHook) {
                    const token = data.Amount.currency;
                    const issuer = data.Amount.issuer;
                    const isRedeem = (token === this.cfg.xrpl.token && issuer === this.cfg.xrpl.address);
                    if (isRedeem) {
                        const memos = data.Memos;
                        const txHash = data.hash;
                        const txAccount = data.Account;
                        const txPubKey = data.SigningPubKey;
                        const amount = parseInt(data.Amount.value);
                        const deserialized = memos.map(m => {
                            return {
                                type: m.Memo.MemoType ? hexToASCII(m.Memo.MemoType) : null,
                                format: m.Memo.MemoFormat ? hexToASCII(m.Memo.MemoFormat) : null,
                                data: m.Memo.MemoData ? hexToASCII(m.Memo.MemoData) : null
                            };
                        }).filter(m => m.data && m.type === MemoTypes.REDEEM && m.format === MemoFormats.BINARY);

                        this.db.open();
                        for (let instance of deserialized) {

                            let createRes;
                            let hasError = false;
                            try {
                                console.log(`Received redeem from ${txAccount}`)
                                await this.createRedeemRecord(txHash, txAccount, amount);
                                createRes = await this.sashiCli.createInstance(JSON.parse(instance.data));
                                console.log(`Instance created for ${txAccount}`)
                            }
                            catch (e) {
                                hasError = true;
                                console.error(e);
                                createRes = {
                                    code: 'REDEEM_ERR',
                                    message: 'Error occured while redeeming.'
                                }
                            }

                            try {
                                const data = await this.sendRedeemResponse(txHash, txPubKey, txAccount, createRes);

                                if (!hasError) {
                                    this.addToExpiryList(txHash, createRes.content.name, this.getExpiryLedger(data.ledgerVersion, amount));
                                    await this.updateRedeemedRecord(txHash, createRes.content.name, data.ledgerVersion);
                                }
                            }
                            catch (e) {
                                hasError = true;
                                console.error(e);
                            }

                            if (hasError)
                                await this.updateRedeemStatus(txHash, RedeemStatus.FAILED);
                        }
                        this.db.close();
                    }
                }
            }
            else {
                console.error(error);
            }
        });
        this.evernodeXrplAcc.subscribe();

        // Subscribe to transactions when api is reconnected.
        // Because API will be automatically reconnected if it's disconnected.
        this.ripplAPI.events.on(Events.RECONNECTED, (e) => {
            this.evernodeXrplAcc.subscribe();
        });
    }

    async checkForRegistration() {
        // Create trustline with evernode account.
        if (!this.cfg.xrpl.regTrustHash) {
            const res = await this.xrplAcc.createTrustline(EVR_CUR_CODE, this.cfg.xrpl.hookAddress, EVR_LIMIT);
            if (res) {
                this.cfg.xrpl.regTrustHash = res.txHash;
                this.persistConfig();
                console.log(`Created ${EVR_CUR_CODE} trustline with evernode account.`)
            }
        }

        // Make registration fee evernode account.
        if (!this.cfg.xrpl.regFeeHash) {
            const memoData = `${this.cfg.xrpl.token};${this.cfg.host.instanceSize};${this.cfg.host.location}`
            // For now we comment EVR reg fee transaction and make XRP transaction instead.
            // const res = await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
            //     REG_FEE,
            //     EVR_CUR_CODE,
            //     this.cfg.xrpl.address,
            //     [{ type: MemoTypes.HOST_REG, format: MemoFormats.TEXT, data: memoData }]);
            const res = await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
                REG_FEE,
                "XRP",
                null,
                [{ type: MemoTypes.HOST_REG, format: MemoFormats.TEXT, data: memoData }]);
            if (res) {
                this.cfg.xrpl.regFeeHash = res.txHash;
                this.persistConfig();
                console.log('Registration payment made for evernode account.')
            }
        }
    }

    async sendRedeemResponse(txHash, txPubkey, txAccount, response) {
        // Verifying the pubkey.
        const derivedAddress = this.ripplAPI.deriveAddress(txPubkey);
        if (derivedAddress !== txAccount)
            throw 'Invalid public key for encryption';

        const encrypted = await EncryptionHelper.encrypt(txPubkey, response);

        return (await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
            RES_FEE,
            "XRP",
            null,
            [{ type: MemoTypes.REDEEM_REF, format: MemoFormats.BINARY, data: txHash },
            { type: MemoTypes.REDEEM_RESP, format: MemoFormats.BINARY, data: encrypted }]));
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
        return createdOnLedger + (moments * LEDGERS_PER_MOMENT);
    }

    readConfig() {
        this.cfg = JSON.parse(fs.readFileSync(this.configPath).toString());
    }

    persistConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
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
        if (res.content && typeof res.content == 'string' && res.content.endsWith("error"))
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
    const args = process.argv;

    // This is used for logging purposes.
    // Logs are formatted with the timestamp and a log file will be created inside log directory.
    if (args.includes('--enable-logging'))
        logger.init('log/mb-xrpl.log');

    if (args.length < 3)
        throw "Arguments mismatch.\n Usage: node mb-xrpl <ripple server url>";

    let sashiCliPath = SASHI_CLI_PATH_PROD;
    // Use sashi CLI in the build folder for dev environment.
    if (args.includes('--dev'))
        sashiCliPath = SASHI_CLI_PATH_DEV;

    console.log('Starting the xrpl message board' + (args[3] == '--dev' ? ' (in dev mode)' : ''));

    // Read Ripple Server Url.
    const rippleServer = args[2];
    const mb = new MessageBoard(CONFIG_PATH, DB_PATH, sashiCliPath, rippleServer);
    await mb.init();
}

main().catch(console.error);