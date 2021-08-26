const fs = require('fs');
const { execSync } = require("child_process");
const xrpl = require('./ripple-handler');
const sqlite = require('./sqlite-handler');
const XrplAccount = xrpl.XrplAccount;
const RippleAPIWarpper = xrpl.RippleAPIWarpper;
const SqliteDatabase = sqlite.SqliteDatabase;

const CONFIG_PATH = 'mb-xrpl.cfg';
const DB_PATH = 'mb-xrpl.sqlite';
const DB_TABLE_NAME = 'redeem_ops';
const EVR_CUR_CODE = 'EVR';
const EVR_LIMIT = 99999999;
const REG_FEE = 5;
const RES_FEE = 0.000001;

const RedeemStatus = {
    Redeeming: 'Redeeming',
    Redeemed: 'Redeemed',
    Failed: 'Failed',
    Expired: 'Expired'
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

        if (!fs.existsSync(this.configPath))
            throw `${this.configPath} does not exist.`;
        else if (!fs.existsSync(sashiCliPath))
            throw `Sashi CLI does not exist in ${sashiCliPath}.`;

        this.readConfig();
        this.sashiCli = new SashiCLI(sashiCliPath);
        this.ripplAPI = new RippleAPIWarpper(rippleServer);
        this.db = new SqliteDatabase(dbPath);
        this.createRedeemTable();
    }

    async init() {
        if (!this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.token || !this.cfg.xrpl.hookAddress)
            throw "Required cfg fields cannot be empty.";

        try { await this.ripplAPI.connect(); }
        catch (e) { throw e; }

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
            //     [{ type: xrpl.MemoTypes.HOST_REG, format: xrpl.MemoFormats.TEXT, data: memoData }]);
            const res = await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
                REG_FEE,
                "XRP",
                null,
                [{ type: xrpl.MemoTypes.HOST_REG, format: xrpl.MemoFormats.TEXT, data: memoData }]);
            if (res) {
                this.cfg.xrpl.regFeeHash = res;
                this.persistConfig();
                console.log('Registration payment made for evernode account.')
            }
        }

        this.evernodeXrplAcc = new XrplAccount(this.ripplAPI.api, this.cfg.xrpl.hookAddress);

        this.evernodeXrplAcc.events.on(xrpl.Events.PAYMENT, (data, error) => {
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
                        }).filter(m => m.data && m.type === xrpl.MemoTypes.INST_CRET && m.format === xrpl.MemoFormats.BINARY);
                        for (let instance of deserialized) {
                            let res;
                            try {
                                this.createRedeemRecord(txHash, txAccount, amount);
                                res = this.sashiCli.createInstance(JSON.parse(instance.data));
                                console.log(`Instance created for ${txAccount}`)
                                this.updateRedeemStatus(txHash, RedeemStatus.Redeemed);
                            }
                            catch (e) {
                                res = e;
                                console.error(e);
                                this.updateRedeemStatus(txHash, RedeemStatus.Failed);
                            }
                            this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
                                RES_FEE,
                                "XRP",
                                null,
                                [{ type: xrpl.MemoTypes.INST_CRET_REF, format: xrpl.MemoFormats.BINARY, data: txHash },
                                { type: xrpl.MemoTypes.INST_CRET_RESP, format: xrpl.MemoFormats.BINARY, data: res }])
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
        this.ripplAPI.events.on(xrpl.Events.RECONNECTED, (e) => {
            this.evernodeXrplAcc.subscribe();
        });
    }

    createRedeemTable() {
        // Create table if not exists.
        this.db.createTableIfNotExists(this.redeemTable, [
            { name: 'timestamp', type: sqlite.DataTypes.INTEGER, notNull: true },
            { name: 'tx_hash', type: sqlite.DataTypes.TEXT, notNull: true },
            { name: 'user_xrp_address', type: sqlite.DataTypes.TEXT, notNull: true },
            { name: 'h_token_amount', type: sqlite.DataTypes.INTEGER, notNull: true },
            { name: 'status', type: sqlite.DataTypes.TEXT, notNull: true }
        ]);
    }

    createRedeemRecord(txHash, txUserAddress, txAmount) {
        this.db.insertValue(this.redeemTable, {
            timestamp: Date.now(),
            tx_hash: txHash,
            user_xrp_address: txUserAddress,
            h_token_amount: txAmount,
            status: RedeemStatus.Redeeming
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

    createInstance(msg) {
        if (!msg.type)
            msg.type = 'create';

        let output = execSync(`${this.cliPath} json -m '${JSON.stringify(msg)}'`, { stdio: 'pipe' });
        let message = Buffer.from(output).toString();
        message = JSON.parse(message.substring(0, message.length - 1)); // Skipping the \n from the result.
        if (message.content && typeof message.content == 'string' && message.content.endsWith("error"))
            throw message;

        return message;
    }

    checkStatus() {
        const output = execSync(`${this.cliPath} status`, { stdio: 'pipe' });
        let message = Buffer.from(output).toString();
        message = message.substring(0, message.length - 1); // Skipping the \n from the result.
        console.log(`Sashi CLI : ${message}`);
        return message;
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