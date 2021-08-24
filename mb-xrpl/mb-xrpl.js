const fs = require('fs');
const { execSync } = require("child_process");
const xrpl = require('./xrp-account');
const XrplAccount = xrpl.XrplAccount;

const CONFIG_PATH = 'mb-xrpl.cfg';
const EVR_CUR_CODE = 'EVR';
const EVR_LIMIT = 99999999;
const REG_FEE = 5;
const RES_FEE = 0.000001;

const SASHI_CLI_PATH_DEV = "../build/sashi";
const SASHI_CLI_PATH_PROD = "/usr/bin/sashi";

class MessageBoard {
    constructor(configPath, sashiCliPath) {
        this.configPath = configPath;

        if (!fs.existsSync(this.configPath))
            throw `${this.configPath} does not exist.`;
        else if (!fs.existsSync(sashiCliPath))
            throw `Sashi CLI does not exist in ${sashiCliPath}.`;

        this.readConfig();
        this.sashiCli = new SashiCLI(sashiCliPath);
    }

    async init(rippleServer) {
        if (!this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.hookAddress)
            throw "Required cfg fields cannot be empty.";

        this.xrplAcc = new XrplAccount(rippleServer, this.cfg.xrpl.address, this.cfg.xrpl.secret);

        if (!this.cfg.xrpl.regTrustHash) {
            const res = await this.xrplAcc.createTrustline(EVR_CUR_CODE, this.cfg.xrpl.hookAddress, EVR_LIMIT);
            if (res) {
                this.cfg.xrpl.regTrustHash = res;
                this.persistConfig();
            }
        }

        if (!this.cfg.xrpl.regFeeHash) {
            const memoData = `${this.cfg.xrpl.token};${this.cfg.host.instanceSize};${this.cfg.host.location}`
            const res = await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
                REG_FEE,
                EVR_CUR_CODE,
                this.cfg.xrpl.hookAddress,
                [{ type: xrpl.MemoTypes.HOST_REG, format: xrpl.MemoFormats.TEXT, data: memoData }]);
            if (res) {
                this.cfg.xrpl.regFeeHash = res;
                this.persistConfig();
            }
        }

        this.evernodeXrplAcc = new XrplAccount(rippleServer, this.cfg.xrpl.hookAddress);

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
                        const txHash = data.hash;
                        for (let instance of deserialized) {
                            try {
                                this.sashiCli.checkStatus();
                                const instanceInfo = this.sashiCli.createInstance(JSON.parse(instance.data));
                                this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
                                    RES_FEE,
                                    "XRP",
                                    null,
                                    [{ type: xrpl.MemoTypes.INST_CRET_REF, format: xrpl.MemoFormats.BINARY, data: txHash },
                                    { type: xrpl.MemoTypes.INST_CRET_RESP, format: xrpl.MemoFormats.BINARY, data: instanceInfo }])
                                    .then(res => console.log(res)).catch(console.error);
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

    readConfig() {
        this.cfg = JSON.parse(fs.readFileSync(this.configPath).toString());
    }

    persistConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
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
    // Read Ripple Server Url.
    const args = process.argv;
    if (args.length < 3)
        throw 'Ripple Server Url argument is required.';

    let sashiCliPath;
    if (args.length == 4 && args[3] == 'dev')
        sashiCliPath = SASHI_CLI_PATH_DEV;
    else if (args.length == 3 || (args.length == 4 && args[3] == 'prod'))
        sashiCliPath = SASHI_CLI_PATH_PROD;
    else
        throw "Arguments mismatch.\n Usage: node message-board (optional)<dev|prod>";

    const rippleServer = args[2];
    const mb = new MessageBoard(CONFIG_PATH, sashiCliPath);
    await mb.init(rippleServer);
}

main().catch(console.error);