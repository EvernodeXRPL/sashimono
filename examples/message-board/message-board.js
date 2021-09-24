const https = require('https');
const http = require('http');
const fs = require('fs');
const readLine = require('readline');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require("child_process");
const express = require('express');

const cliDevPath = "../../build/sashi";
const cliProdPath = "/usr/bin/sashi";
let cliPath;
let args = process.argv;
if (args.length == 3 && args[2] == 'prod')
    cliPath = cliProdPath;
else if (args.length == 2 || (args.length == 3 && args[2] == 'dev'))
    cliPath = cliDevPath;
else {
    console.log("Arguments mismatch.\n Usage: node message-board (optional)<dev|prod>");
    process.exit(0);
}

if (!fs.existsSync(cliPath)) {
    console.error(`Sashi CLI does not exist in ${cliPath}.`)
    process.exit(0);
}

let restServer;

/**
 * Interactive interface to get message from the command line and sent it to all the connected agents.
*/
const interatctiveInterface = async () => {
    // start listening for stdin
    const rl = readLine.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    // On ctrl + c we should close SA connection gracefully.
    rl.on('SIGINT', () => {
        console.log('SIGINT received...');
        rl.close();
        restServer && restServer.close();
    });

    const askForInput = (label, defaultValue) => {
        return new Promise(resolve => {
            rl.question(`${label}? `, (input) => {
                resolve(input && input.length > 0 ? input : defaultValue);
            })
        })
    }

    const askForInstanceConfig = async (config) => {
        modifyNode = await askForInput('Modify node section? [y/N]', 'n');
        if (modifyNode === 'y' || modifyNode === 'Y') {
            role = await askForInput('Role: validator | observer(optional)');
            if (role && role != 'validator' && role != 'observer') {
                console.error('Invalid role. (Should be "validator" or "observer").')
                return -1;
            }
            history = await askForInput('History <{full|custom},max_primary_shards,max_raw_shards> (optional)');
            split = [];
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

        modifyContract = await askForInput('Modify contract section? [y/N]', 'n');
        if (modifyContract === 'y' || modifyContract === 'Y') {
            unl = await askForInput('Comma seperated UNL <pubkey1>,<pubkey2>,...');
            execute = await askForInput('Execute contract? (optional)');
            roundtime = await askForInput('Roundtime? (optional)');
            log = await askForInput('log <{true|false},max_mbytes_per_file,max_file_count> (optional)');
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
        modifyMesh = await askForInput('Modify mesh section? [y/N]', 'n');
        if (modifyMesh === 'y' || modifyMesh === 'Y') {
            idleTimeout = await askForInput('Idle timeout?(optional)');
            peers = await askForInput('Comma seperated Peer List <host1:port1>,<host2:port2>,...(optional)');
            msgForwarding = await askForInput('Message forwarding [true|false]?(optional)');
            set01 = await askForInput('Comma seperated max_connections, max_known_connections and max_in_connections_per_host?(optional)');
            if (set01) {
                split01 = set01.split(',');
                if (split01.length == 0 || split01.length !== 3) {
                    console.error('Make sure to add all three. Eg: 1,1,1');
                    return -1;
                }
            }

            set02 = await askForInput('Comma seperated max_bytes_per_msg, max_bytes_per_min and max_bad_msgs_per_min?(optional)');
            if (set02) {
                split02 = set02.split(',');
                if (split02.length == 0 || split02.length !== 3) {
                    console.error('Make sure to add all three. Eg: 1,1,1');
                    return -1;
                }
            }

            set03 = await askForInput('Comma seperated max_bad_msgsigs_per_min and max_dup_msgs_per_min?(optional)');
            if (set03) {
                split03 = set03.split(',');
                if (split03.length == 0 || split03.length !== 2) {
                    console.error('Make sure to add all two. Eg: 1,1');
                    return -1;
                }
            }

            peerDiscovery = await askForInput('Peer discovery <{true|false}, Interval>?(optional)');
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
        modifyUser = await askForInput('Modify user section? [y/N]', 'n');
        if (modifyUser === 'y' || modifyUser === 'Y') {
            idleTimeout = await askForInput('Idle timeout?(optional)');
            set01 = await askForInput('Comma seperated max_bytes_per_msg, max_bytes_per_min and max_bad_msgs_per_min?(optional)');
            if (set01) {
                split01 = set01.split(',');
                if (split01.length == 0 || split01.length !== 3) {
                    console.error('Make sure to add all three. Eg: 1,1,1');
                    return -1;
                }
            }
            set02 = await askForInput('Comma seperated max_connections, max_in_connections_per_host and concurrent_read_reqeuests?(optional)');
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
        modifyHpfs = await askForInput('Modify hpfs section? [y/N]', 'n');
        if (modifyHpfs === 'y' || modifyHpfs === 'Y') {
            logLevel = await askForInput('Hpfs log level?(optional)');
            config.hpfs = logLevel ? {
                log_level: logLevel ? logLevel : undefined
            } : undefined;
        }

        modifyLogs = await askForInput('Modify log section? [y/N]', 'n');
        if (modifyLogs === 'y' || modifyLogs === 'Y') {
            logLevel = await askForInput('HP log level?(optional)');
            set01 = await askForInput('Comma seperated max_mbytes_per_file and max_file_count?(optional)');
            if (set01) {
                split01 = set01.split(',');
                if (split01.length == 0 || split01.length !== 2) {
                    console.error('Make sure to add all two. Eg: 1,1');
                    return -1;
                }
            }
            loggers = await askForInput('Comma seperated loggers?(optional)');
            config.log = {
                log_level: logLevel ? logLevel : undefined,
                max_mbytes_per_file: set01 ? parseInt(split01[0]) : undefined,
                max_file_count: set01 ? parseInt(split01[1]) : undefined,
                loggers: loggers ? loggers.split(',') : undefined
            };
        }
        return 0;
    }

    console.log("Ready to accept inputs.");

    const inputPump = () => {
        rl.question('', async (inp) => {
            if (inp.length > 0) {
                switch (inp) {
                    case 'status':
                        checkAgentStatus();
                        break;
                    case 'list':
                        getList();
                        break;
                    case 'create':
                        contractId = await askForInput('Contract ID (default:uuidv4)', uuidv4());
                        image = await askForInput('Image: 1=ubuntu(default) | 2=nodejs', "1");
                        if (image != "1" && image != "2") {
                            console.error('Invalid image. (Should be "1" or "2").')
                            break;
                        }
                        let createConfig = {};
                        addConfig = await askForInput('Add config section? [y/N]', 'n');
                        let ret = -1;
                        if (addConfig === 'y' || addConfig === 'Y')
                            ret = await askForInstanceConfig(createConfig);

                        sendToAgent(JSON.stringify({
                            type: 'create',
                            owner_pubkey: 'ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50',
                            contract_id: contractId,
                            image: (image == "1" ? "hp.latest-ubt.20.04" : "hp.latest-ubt.20.04-njs.14"),
                            config: ret !== -1 ? createConfig : undefined
                        }));
                        break;
                    // case 'initiate':
                    //     containerName = await askForInput('Container Name');
                    //     let config = {};
                    //     const iniRet = await askForInstanceConfig(config);

                    //     sendToAgent(JSON.stringify({
                    //         type: 'initiate',
                    //         container_name: containerName,
                    //         config: iniRet !== -1 ? config : undefined
                    //     }));
                    //     break;
                    case 'destroy':
                        containerName = await askForInput('Container Name');
                        sendToAgent(JSON.stringify({
                            type: 'destroy',
                            container_name: containerName
                        }))
                        break;
                    case 'start':
                        containerName = await askForInput('Container Name');
                        sendToAgent(JSON.stringify({
                            type: 'start',
                            container_name: containerName
                        }))
                        break;
                    case 'stop':
                        containerName = await askForInput('Container Name');
                        sendToAgent(JSON.stringify({
                            type: 'stop',
                            container_name: containerName
                        }))
                        break;

                    default:
                        console.error('Invalid command. Only valid [create, destroy, start and stop]');
                        break;
                }

            }

            inputPump();
        })
    }
    inputPump();
}

const sendToAgent = (msg, res = null) => {
    try {
        let output = execSync(`${cliPath} json -m '${msg}'`, { stdio: 'pipe' });
        let message = Buffer.from(output).toString();
        message = JSON.parse(message.substring(0, message.length - 1)); // Skipping the \n from the result.
        console.log('Received: ', message);
        res && res.status((message.content && typeof message.content == 'string' && message.content.endsWith("error")) ? 500 : 200).send(message);
    }
    catch (e) {
        console.error(`Message sending error. ${e}`);
        res && res.status(500).send(`Message sending error. ${e}`);
    }
}

const getList = (res = null) => {
    try {
        let output = execSync(`${cliPath} list`, { stdio: 'pipe' });
        let message = Buffer.from(output).toString();
        if (!res)
            console.log('Received: ', message);
        else
            res.status(200).send(message);
    }
    catch (e) {
        console.error(`Message sending error. ${e}`);
        res && res.status(500).send(`Message sending error. ${e}`);
    }
}

const checkAgentStatus = (res = null) => {
    try {
        let output = execSync(`${cliPath} status`, { stdio: 'pipe' });
        let message = Buffer.from(output).toString();
        message = message.substring(0, message.length - 1); // Skipping the \n from the result.
        console.log(`Socket ${message} is online.`);
        res && res.status(200).send(message);
        return true;
    }
    catch (e) {
        console.error(`Socket is offline. ${e}`);
        res && res.status(500).send(`Socket is offline. ${e}`);
        return false;
    }
}

const webServerProtocol = (process.env.SSL === "true") ? "https" : "http";
const webServerPort = 5001;

const restApi = async () => {
    // Generate tls keys if not found.
    if (webServerProtocol == "https" && !fs.existsSync('./tlskey.pem')) {
        console.log("TLS key files not detected. Generating..");
        execSync("openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout tlskey.pem -out tlscert.pem -subj \"/C=SA/ST=SA/L=SA/O=SA/CN=SA\"");
        console.log("New tls key files generated.")
    }

    const app = express();
    app.use(express.json());
    app.post("/status", (req, res) => {
        checkAgentStatus(res);
    });
    app.post("/list", (req, res) => {
        getList(res);
    });
    app.post("/create", (req, res) => {
        const msg = {
            id,
            type: 'create',
            owner_pubkey: req.body.owner_pubkey,
            contract_id: (req.body.contract_id === "") ? uuidv4() : req.body.contract_id,
            image: req.body.image ? req.body.image : "hp.latest-ubt.20.04"
        };
        sendToAgent(JSON.stringify(msg), res);
    });
    app.post("/initiate", (req, res) => {
        const msg = {
            id,
            type: 'initiate',
            container_name: req.body.container_name,
            peers: req.body.peers ? req.body.peers : [],
            unl: req.body.unl ? req.body.unl : [],
            role: req.body.role ? req.body.role : 'validator',
            history: req.body.history ? req.body.history : 'custom',
            max_primary_shards: req.body.max_primary_shards ? req.body.max_primary_shards : 1,
            max_raw_shards: req.body.max_raw_shards ? req.body.max_raw_shards : 1
        };
        sendToAgent(JSON.stringify(msg), res);
    });
    app.post("/start", (req, res) => {
        const msg = {
            id,
            type: 'start',
            container_name: req.body.container_name
        };
        sendToAgent(JSON.stringify(msg), res);
    });
    app.post("/stop", (req, res) => {
        const msg = {
            id,
            type: 'stop',
            container_name: req.body.container_name
        };
        sendToAgent(JSON.stringify(msg), res);
    });
    app.post("/destroy", (req, res) => {
        const msg = {
            id,
            type: 'destroy',
            container_name: req.body.container_name
        };
        sendToAgent(JSON.stringify(msg), res);
    });
    restServer = (webServerProtocol == "https") ?
        https.createServer({
            key: fs.readFileSync('./tlskey.pem'),
            cert: fs.readFileSync('./tlscert.pem')
        }, app) :
        http.createServer(app);

    restServer.listen(webServerPort, () => console.log(`Web server listening at ${webServerProtocol}://localhost:${webServerPort}`));
}

(async () => {
    if (checkAgentStatus()) {
        await restApi();
        await interatctiveInterface();
    }
})();
