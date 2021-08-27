const fs = require('fs');
const { exec } = require("child_process");
const { XrplAccount, RippleAPIWarpper, Events, MemoFormats, MemoTypes } = require('./ripple-handler');
const { SqliteDatabase, DataTypes } = require('./sqlite-handler');

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
        this.destroyHandlers = [];

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
        this.createRedeemTable();

        // const redeems = await this.getRedeemedRecords();
        // for (const redeem of redeems) {
        //     const txHash = redeem.tx_hash;
        //     const amount = redeem.h_token_amount;
        //     const curLedger = await this.ripplAPI.getLedgerVersion();
        //     const life = curLedger + (amount * LEDGERS_PER_MOMENT);
        //     this.destroyOnLedger(res.content.name, txHash, life);
        // }

        this.db.close();

        this.ripplAPI.events.on(Events.LEDGER, async (e) => {
            const curHandlers = this.destroyHandlers.filter(h => h.maxLedgerVersion <= e.ledgerVersion);
            this.destroyHandlers = this.destroyHandlers.filter(h => h.maxLedgerVersion > e.ledgerVersion);
            for (const h of curHandlers) {
                await h.handle();
            }
        });

        this.xrplAcc = new XrplAccount(this.ripplAPI.api, this.cfg.xrpl.address, this.cfg.xrpl.secret);

        // Create trustline with evernode account.
        if (!this.cfg.xrpl.regTrustHash) {
            const res = await this.xrplAcc.createTrustline(EVR_CUR_CODE, this.cfg.xrpl.hookAddress, EVR_LIMIT);
            if (res) {
                this.cfg.xrpl.regTrustHash = res;
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
                this.cfg.xrpl.regFeeHash = res;
                this.persistConfig();
                console.log('Registration payment made for evernode account.')
            }
        }

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
                    const amount = parseInt(data.Amount.value);
                    const isRedeem = (token === this.cfg.xrpl.token && issuer === this.cfg.xrpl.address);
                    if (isRedeem) {
                        const memos = data.Memos;
                        const txHash = data.hash;
                        const txAccount = data.Account;
                        const deserialized = memos.map(m => {
                            return {
                                type: m.Memo.MemoType ? hexToASCII(m.Memo.MemoType) : null,
                                format: m.Memo.MemoFormat ? hexToASCII(m.Memo.MemoFormat) : null,
                                data: m.Memo.MemoData ? hexToASCII(m.Memo.MemoData) : null
                            };
                        }).filter(m => m.data && m.type === MemoTypes.REDEEM && m.format === MemoFormats.BINARY);
                        for (let instance of deserialized) {
                            let res;

                            this.db.open();
                            try {
                                console.log(`Received redeem from ${txAccount}`)
                                this.createRedeemRecord(txHash, txAccount, amount);
                                res = await this.sashiCli.createInstance(JSON.parse(instance.data));
                                console.log(`Instance created for ${txAccount}`)
                                const curLedger = await this.ripplAPI.getLedgerVersion();
                                const life = curLedger + (amount * LEDGERS_PER_MOMENT);
                                this.destroyOnLedger(res.content.name, txHash, life);
                                this.updateRedeemStatus(txHash, RedeemStatus.REDEEMED);
                            }
                            catch (e) {
                                console.error(e);
                                res = {
                                    code: 'REDEEM_ERR',
                                    message: 'Error occured while redeeming.'
                                }
                                this.updateRedeemStatus(txHash, RedeemStatus.FAILED);
                            }
                            this.db.close();

                            this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
                                RES_FEE,
                                "XRP",
                                null,
                                [{ type: MemoTypes.REDEEM_REF, format: MemoFormats.BINARY, data: txHash },
                                { type: MemoTypes.REDEEM_RESP, format: MemoFormats.BINARY, data: res }])
                                .then(res => console.log(res)).catch(console.error);
                        }
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

    destroyOnLedger(containerName, txHash, ledgerVersion) {
        this.destroyHandlers.push({
            maxLedgerVersion: ledgerVersion,
            handle: async () => {
                console.log(`Moments exceeded. Destroying ${containerName}`)
                await this.sashiCli.destroyInstance(containerName);

                this.db.open();
                this.updateRedeemStatus(txHash, RedeemStatus.EXPIRED);
                this.db.close();

                console.log(`Destroyed ${containerName}`)
            }
        });
    }

    createRedeemTable() {
        // Create table if not exists.
        this.db.createTableIfNotExists(this.redeemTable, [
            { name: 'timestamp', type: DataTypes.INTEGER, notNull: true },
            { name: 'tx_hash', type: DataTypes.TEXT, notNull: true },
            { name: 'user_xrp_address', type: DataTypes.TEXT, notNull: true },
            { name: 'h_token_amount', type: DataTypes.INTEGER, notNull: true },
            { name: 'status', type: DataTypes.TEXT, notNull: true }
        ]);
    }

    async getRedeemedRecords() {
        return (await this.db.getValues(this.redeemTable, { status: RedeemStatus.REDEEMED }));
    }

    createRedeemRecord(txHash, txUserAddress, txAmount) {
        this.db.insertValue(this.redeemTable, {
            timestamp: Date.now(),
            tx_hash: txHash,
            user_xrp_address: txUserAddress,
            h_token_amount: txAmount,
            status: RedeemStatus.REDEEMING
        });
    }

    updateRedeemStatus(txHash, status) {
        this.db.updateValue(this.redeemTable, { status: status }, { tx_hash: txHash });
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
    // Read Ripple Server Url.
    const args = process.argv;
    if (args.length < 3)
        throw "Arguments mismatch.\n Usage: node mb-xrpl rippleServer";

    let sashiCliPath = SASHI_CLI_PATH_PROD;
    // Use sashi CLI in the build folder for dev environment.
    if (args.length == 4 && args[3] == 'dev')
        sashiCliPath = SASHI_CLI_PATH_DEV;

    const rippleServer = args[2];
    const mb = new MessageBoard(CONFIG_PATH, DB_PATH, sashiCliPath, rippleServer);
    await mb.init();
}

main().catch(console.error);