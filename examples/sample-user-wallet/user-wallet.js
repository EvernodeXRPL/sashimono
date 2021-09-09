const fs = require('fs');
const readLine = require('readline');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const { XrplAccount, RippleAPIWarpper, Events, MemoFormats, MemoTypes, EncryptionHelper } = require('../../mb-xrpl/lib/ripple-handler');

const RIPPLE_SERVER = 'wss://hooks-testnet.xrpl-labs.com';
const FAUSET_URL = 'https://hooks-testnet.xrpl-labs.com/newcreds';

const OWNER_PUBKEY = 'ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50'
const CONFIG_PATH = 'user.cfg';

// Test Hook
// rwQ7ECXhkF1ZF6qFHH4y7sc1y3ZnXgf6Rh
// ssYnjnveDXzeibGQFkZB3aRUfCHJN

const createXrplAccount = async () => {
    const resp = await fetch(FAUSET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    return (await resp.json()).account;
}

class TestUser {
    constructor(configPath, rippleServer) {
        this.promises = {};
        this.configPath = configPath;

        this.rippleAPI = new RippleAPIWarpper(rippleServer);
    }

    async init() {
        if (!fs.existsSync(this.configPath)) {
            this.cfg = { xrpl: { address: "", secret: "", hookAddress: "", hostAddress: "", hostToken: "" } }
            const newAcc = await createXrplAccount();
            this.cfg.xrpl.address = newAcc.address;
            this.cfg.xrpl.secret = newAcc.secret;
            this.persistConfig();
            console.log(`Update the ${this.configPath} and restart the program.`);
            process.exit(0);
        }
        else {
            this.readConfig();
        }

        if (!this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.hostAddress || !this.cfg.xrpl.hostToken || !this.cfg.xrpl.hookAddress)
            throw "Required cfg fields cannot be empty.";

        try { await this.rippleAPI.connect(); }
        catch (e) { throw e; }

        this.xrplAcc = new XrplAccount(this.rippleAPI, this.cfg.xrpl.address, this.cfg.xrpl.secret);
        this.evernodeXrplAcc = new XrplAccount(this.rippleAPI, this.cfg.xrpl.hookAddress);

        // Handle the transactions on evernode account and filter out redeem responses.
        this.evernodeXrplAcc.events.on(Events.PAYMENT, async (data, error) => {
            if (data) {
                // Check whether issued currency
                const isXrp = (typeof data.Amount !== "object");
                const isToHook = data.Destination === this.cfg.xrpl.hookAddress;
                const isFromHost = data.Account === this.cfg.xrpl.hostAddress;
                // Filter responses from host to evernode account.
                if (isXrp && isToHook && isFromHost) {
                    // Filter instance responses
                    const instanceRef = data.Memos.filter(m => m.data && m.type === MemoTypes.REDEEM_REF && m.format === MemoFormats.BINARY);
                    const instanceInfo = data.Memos.filter(m => m.data && m.type === MemoTypes.REDEEM_RESP && m.format === MemoFormats.BINARY);

                    if (instanceRef && instanceRef.length && instanceInfo && instanceInfo.length) {
                        const ref = instanceRef[0].data;
                        // Only resolve the instance responses which matches to our reference.
                        // This will filter out the resonses belongs to us.
                        let resolver = this.promises[ref];
                        if (resolver) {
                            let info = instanceInfo[0].data;
                            const keyPair = this.xrplAcc.deriveKeypair();
                            info = await EncryptionHelper.decrypt(keyPair.privateKey, info);
                            try {
                                info = JSON.parse(info);
                            }
                            catch (e) {
                                console.error(e)
                            }

                            resolver(info);
                            delete this.promises[ref];
                        }
                    }
                }
            }
            else {
                console.error(error);
            }
        });
        this.evernodeXrplAcc.subscribe();

        this.rl = readLine.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        await this.inputPump();
    }

    async inputPump() {
        const inp = await this.askForInput('Enter command');
        if (inp && inp.length > 0) {
            switch (inp) {
                case 'create':
                    const res = await this.createInstance();
                    console.log("Instance creation results : ", res);
                    break;
                default:
                    console.error('Invalid command. Only valid [create]');
                    break;
            }
        }
        await this.inputPump();
    }

    askForInput(label, defaultValue) {
        return new Promise(resolve => {
            this.rl.question(label ? `${label} : ` : '', (input) => {
                resolve(input && input.length > 0 ? input : defaultValue);
            })
        })
    }

    async askForInstanceConfig(config) {
        const modifyNode = await this.askForInput('Modify node section? [y/N]', 'n');
        if (modifyNode === 'y' || modifyNode === 'Y') {
            const role = await this.askForInput('Role: validator | observer(optional)');
            if (role && role != 'validator' && role != 'observer') {
                console.error('Invalid role. (Should be "validator" or "observer").')
                return -1;
            }
            const history = await this.askForInput('History <{full|custom},max_primary_shards,max_raw_shards> (optional)');
            let split = [];
            if (history) {
                split = history.split(',');
                if (split.length == 0 || split.length !== 3) {
                    console.error('Invalid history.')
                    return -1;
                }
                else if (split[0] != 'full' && split[0] != 'custom') {
                    console.error('Invalid history. (Should be "full" or "custom").')
                    return -1;
                }
            }
            config.node = {
                role: role,
                history: history ? split[0] : undefined,
                history_config: history ? {
                    max_primary_shards: parseInt(split[1]),
                    max_raw_shards: parseInt(split[2])
                } : undefined
            };
        }

        const modifyContract = await this.askForInput('Modify contract section? [y/N]', 'n');
        if (modifyContract === 'y' || modifyContract === 'Y') {
            const unl = await this.askForInput('Comma seperated UNL <pubkey1>,<pubkey2>,...');
            const execute = await this.askForInput('Execute contract? (optional)');
            const roundtime = await this.askForInput('Roundtime? (optional)');
            const log = await this.askForInput('log <{true|false},max_mbytes_per_file,max_file_count> (optional)');
            if (log) {
                split = log.split(',');
                if (split.length == 0 || split.length !== 3) {
                    console.error('Invalid log config.')
                    return -1;
                }
                else if (split[0] != 'true' && split[0] != 'false') {
                    console.error('Log enable tag should be either true or false')
                    return -1;
                }
            }
            config.contract = {
                execute: execute ? (execute === 'true' ? true : false) : undefined,
                roundtime: roundtime ? parseInt(roundtime) : undefined,
                log: log ? {
                    enable: split[0] === 'true' ? true : false,
                    max_mbytes_per_file: parseInt(split[1]),
                    max_file_count: parseInt(split[2])
                } : undefined,
                unl: unl ? unl.split(',') : undefined
            }
        }
        const modifyMesh = await this.askForInput('Modify mesh section? [y/N]', 'n');
        if (modifyMesh === 'y' || modifyMesh === 'Y') {
            const idleTimeout = await this.askForInput('Idle timeout?(optional)');
            const peers = await this.askForInput('Comma seperated Peer List <host1:port1>,<host2:port2>,...(optional)');
            const msgForwarding = await this.askForInput('Message forwarding [true|false]?(optional)');
            const set01 = await this.askForInput('Comma seperated max_connections, max_known_connections and max_in_connections_per_host?(optional)');
            if (set01) {
                const split01 = set01.split(',');
                if (split01.length == 0 || split01.length !== 3) {
                    console.error('Make sure to add all three. Eg: 1,1,1');
                    return -1;
                }
            }

            const set02 = await this.askForInput('Comma seperated max_bytes_per_msg, max_bytes_per_min and max_bad_msgs_per_min?(optional)');
            if (set02) {
                const split02 = set02.split(',');
                if (split02.length == 0 || split02.length !== 3) {
                    console.error('Make sure to add all three. Eg: 1,1,1');
                    return -1;
                }
            }

            const set03 = await this.askForInput('Comma seperated max_bad_msgsigs_per_min and max_dup_msgs_per_min?(optional)');
            if (set03) {
                const split03 = set03.split(',');
                if (split03.length == 0 || split03.length !== 2) {
                    console.error('Make sure to add all two. Eg: 1,1');
                    return -1;
                }
            }

            let peerDiscovery = await this.askForInput('Peer discovery <{true|false}, Interval>?(optional)');
            if (peerDiscovery) {
                peerDiscovery = peerDiscovery.split(',');
                if (peerDiscovery.length == 0 || peerDiscovery.length !== 2) {
                    console.error('Make sure to add all two. Eg: true,10000');
                    return -1;
                }
            }

            config.mesh = {
                idle_timeout: idleTimeout ? parseInt(idleTimeout) : undefined,
                known_peers: peers ? peers.split(',') : undefined,
                msg_forwarding: msgForwarding ? (msgForwarding === 'true' ? true : false) : undefined,
                max_connections: set01 ? parseInt(split01[0]) : undefined,
                max_known_connections: set01 ? parseInt(split01[1]) : undefined,
                max_in_connections_per_host: set01 ? parseInt(split01[2]) : undefined,
                max_bytes_per_msg: set02 ? parseInt(split02[0]) : undefined,
                max_bytes_per_min: set02 ? parseInt(split02[1]) : undefined,
                max_bad_msgs_per_min: set02 ? parseInt(split02[2]) : undefined,
                max_bad_msgsigs_per_min: set03 ? parseInt(split03[0]) : undefined,
                max_dup_msgs_per_min: set03 ? parseInt(split03[1]) : undefined,
                peer_discovery: peerDiscovery ? {
                    enabled: peerDiscovery[0] === 'true' ? true : false,
                    interval: parseInt(peerDiscovery[1])
                } : undefined
            };


        }
        const modifyUser = await this.askForInput('Modify user section? [y/N]', 'n');
        if (modifyUser === 'y' || modifyUser === 'Y') {
            const idleTimeout = await this.askForInput('Idle timeout?(optional)');
            const set01 = await this.askForInput('Comma seperated max_bytes_per_msg, max_bytes_per_min and max_bad_msgs_per_min?(optional)');
            if (set01) {
                const split01 = set01.split(',');
                if (split01.length == 0 || split01.length !== 3) {
                    console.error('Make sure to add all three. Eg: 1,1,1');
                    return -1;
                }
            }
            const set02 = await this.askForInput('Comma seperated max_connections, max_in_connections_per_host and concurrent_read_reqeuests?(optional)');
            if (set02) {
                split02 = set02.split(',');
                if (split02.length == 0 || split02.length !== 3) {
                    console.error('Make sure to add all three. Eg: 1,1,1');
                    return -1;
                }
            }
            config.user = {
                idle_timeout: idleTimeout ? parseInt(idleTimeout) : undefined,
                max_bytes_per_msg: set01 ? parseInt(split01[0]) : undefined,
                max_bytes_per_min: set01 ? parseInt(split01[1]) : undefined,
                max_bad_msgs_per_min: set01 ? parseInt(split01[2]) : undefined,
                max_connections: set02 ? parseInt(split02[0]) : undefined,
                max_in_connections_per_host: set02 ? parseInt(split02[1]) : undefined,
                concurrent_read_requests: set02 ? parseInt(split02[2]) : undefined
            };
        }
        const modifyHpfs = await this.askForInput('Modify hpfs section? [y/N]', 'n');
        if (modifyHpfs === 'y' || modifyHpfs === 'Y') {
            const logLevel = await this.askForInput('Hpfs log level?(optional)');
            config.hpfs = logLevel ? {
                log_level: logLevel ? logLevel : undefined
            } : undefined;
        }

        const modifyLogs = await this.askForInput('Modify log section? [y/N]', 'n');
        if (modifyLogs === 'y' || modifyLogs === 'Y') {
            const logLevel = await this.askForInput('HP log level?(optional)');
            const set01 = await this.askForInput('Comma seperated max_mbytes_per_file and max_file_count?(optional)');
            if (set01) {
                split01 = set01.split(',');
                if (split01.length == 0 || split01.length !== 2) {
                    console.error('Make sure to add all two. Eg: 1,1');
                    return -1;
                }
            }
            const loggers = await this.askForInput('Comma seperated loggers?(optional)');
            config.log = {
                log_level: logLevel ? logLevel : undefined,
                max_mbytes_per_file: set01 ? parseInt(split01[0]) : undefined,
                max_file_count: set01 ? parseInt(split01[1]) : undefined,
                loggers: loggers ? loggers.split(',') : undefined
            };
        }
        return 0;
    }

    readConfig() {
        this.cfg = JSON.parse(fs.readFileSync(this.configPath).toString());
    }

    persistConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
    }

    async createInstance() {
        const tokenCount = await this.askForInput(`${this.cfg.xrpl.hostToken} amount (default:1)`, 1);
        const contractId = await this.askForInput('Contract ID (default:uuidv4)', uuidv4());
        const image = await this.askForInput('Image: 1=ubuntu(default) | 2=nodejs', "1");
        if (image != "1" && image != "2") {
            console.error('Invalid image. (Should be "1" or "2").')
            return;
        }
        let createConfig = {};
        const addConfig = await this.askForInput('Add config section? [y/N]', 'n');
        let ret = -1;
        if (addConfig === 'y' || addConfig === 'Y')
            ret = await this.askForInstanceConfig(createConfig);

        const data = {
            type: 'create',
            owner_pubkey: OWNER_PUBKEY,
            contract_id: contractId,
            image: (image == "1" ? "hp.0.5-ubt.20.04" : "hp.0.5-ubt.20.04-njs.14"),
            config: ret !== -1 ? createConfig : {}
        };

        const memoData = JSON.stringify(data);
        const res = await this.xrplAcc.makePayment(this.cfg.xrpl.hookAddress,
            +tokenCount,
            this.cfg.xrpl.hostToken,
            this.cfg.xrpl.hostAddress,
            [{ type: MemoTypes.REDEEM, format: MemoFormats.BINARY, data: memoData }]);

        if (res) {
            console.log("Transaction succeed, wait for the instance creation...");
            return new Promise(resolve => {
                this.promises[res.txHash] = resolve;
            });
        }
        else {
            return "Transaction failed.";
        }
    }
}

async function main() {
    const user = new TestUser(CONFIG_PATH, RIPPLE_SERVER);
    await user.init();
}

main().catch(console.error);