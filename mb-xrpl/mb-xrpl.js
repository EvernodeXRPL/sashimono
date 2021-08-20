const fs = require('fs');
const fetch = require('node-fetch');
const { execSync } = require("child_process");
const xrpl = require('./xrp-account');
const XrplAccount = xrpl.XrplAccount;

const FAUSET_URL = 'https://faucet.altnet.rippletest.net/accounts';
const RIPPLE_SERVER = "wss://s.altnet.rippletest.net";
const CONFIG_PATH = 'mb-xrpl.json';
const EVR_CUR_CODE = 'EVR';
const EVR_LIMIT = 99999999;
const REG_FEE = 5;
const RES_FEE = 0.000001;

class MessageBoard {
    constructor() {
        const sashiCliDevPath = "../build/sashi";
        const sashiCliProdPath = "/usr/bin/sashi";
        let sashiCliPath;
        const args = process.argv;
        if (args.length == 3 && args[2] == 'prod')
            sashiCliPath = sashiCliProdPath;
        else if (args.length == 2 || (args.length == 3 && args[2] == 'dev'))
            sashiCliPath = sashiCliDevPath;
        else {
            console.log("Arguments mismatch.\n Usage: node message-board (optional)<dev|prod>");
            process.exit(0);
        }

        if (!fs.existsSync(sashiCliPath)) {
            console.error(`Sashi CLI does not exist in ${sashiCliPath}.`)
            process.exit(0);
        }

        this.readConfig();
        this.sashiCli = new SashiCLI(sashiCliPath);
    }

    async init() {
        if (!this.cfg.xrpl.address) {
            const newAcc = await this.createXrplAccount();
            this.cfg.xrpl.address = newAcc.address;
            this.cfg.xrpl.secret = newAcc.secret;
            this.persistConfig();
        }

        this.xrplAcc = new XrplAccount(RIPPLE_SERVER, this.cfg.xrpl.address, this.cfg.xrpl.secret);

        if (!this.cfg.xrpl.regTrustHash) {
            const res = await this.xrplAcc.createTrustline(EVR_CUR_CODE, this.cfg.xrpl.hookAddress, EVR_LIMIT);
            if (res) {
                this.cfg.xrpl.regTrustHash = res;
                this.persistConfig();
            }
        }

        if (!this.cfg.xrpl.regFeeHash) {
            const memoData = `${this.cfg.xrpl.token};${this.cfg.host.instanceSize};${this.cfg.host.location}`
            const res = await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress, REG_FEE, EVR_CUR_CODE, this.cfg.xrpl.hookAddress, xrpl.MemoTypes.HOST_REG, xrpl.MemoFormats.TEXT, memoData);
            if (res) {
                this.cfg.xrpl.regFeeHash = res;
                this.persistConfig();
            }
        }

        this.evernodeXrplAcc = new XrplAccount(RIPPLE_SERVER, this.cfg.xrpl.hookAddress);

        await this.evernodeXrplAcc.subscribe();
        this.evernodeXrplAcc.on(xrpl.Events.PAYMENT, (data, error) => {
            if (data) {
                // Check whether issued currency
                const isIssuedCurrency = (typeof data.Amount === "object");
                // Check whether incomming to hook.
                const isToHook = data.Destination === this.cfg.xrpl.hookAddress;
                if (isIssuedCurrency && isToHook) {
                    const token = data.Amount.currency;
                    const issuer = data.Amount.issuer;
                    const amount = parseInt(data.Amount.value);
                    const isInstruction = token === this.cfg.xrpl.token && issuer === this.cfg.xrpl.address
                    if (isInstruction) {
                        const memos = data.Memos;
                        const deserialized = memos.map(m => {
                            return {
                                type: m.Memo.MemoType ? this.hexToASCII(m.Memo.MemoType) : null,
                                format: m.Memo.MemoFormat ? this.hexToASCII(m.Memo.MemoFormat) : null,
                                data: this.hexToASCII(m.Memo.MemoData)
                            };
                        }).filter(m => m.type === xrpl.MemoTypes.INST_CRET && m.format === xrpl.MemoFormats.BINARY && m.data);
                        for (let instance of deserialized) {
                            try {
                                this.sashiCli.checkStatus();
                                const instanceInfo = this.sashiCli.createInstance(JSON.parse(instance.data));
                                const memoData = JSON.stringify(instanceInfo);
                                this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress, RES_FEE, "XRP", null, xrpl.MemoTypes.INST_CRET_RESP, xrpl.MemoFormats.BINARY, memoData).then(res => console.log(res)).catch(console.error);
                            }
                            catch (e) {
                                console.error("Error occured while creating instance ", e);
                            }
                        }
                    }
                }
            }
            else {
                console.error(error);
            }
        });
    }

    async createXrplAccount() {
        const resp = await fetch(FAUSET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        return (await resp.json()).account;
    }

    readConfig() {
        this.cfg = JSON.parse(fs.readFileSync(CONFIG_PATH).toString());
    }

    persistConfig() {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.cfg, null, 2));
    }

    hexToASCII(hex) {
        let str = "";
        for (let n = 0; n < hex.length; n += 2) {
            str += String.fromCharCode(parseInt(hex.substr(n, 2), 16));
        }
        return str;
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
        let output = execSync(`${this.cliPath} status`, { stdio: 'pipe' });
        let message = Buffer.from(output).toString();
        message = message.substring(0, message.length - 1); // Skipping the \n from the result.
        return message;
    }
}

async function main() {
    const mb = new MessageBoard();
    await mb.init();
}

main();