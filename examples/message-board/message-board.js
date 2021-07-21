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

    console.log("Ready to accept inputs.");

    const inputPump = () => {
        rl.question('', async (inp) => {
            if (inp.length > 0) {
                switch (inp) {
                    case 'status':
                        checkAgentStatus();
                        break;
                    case 'create':
                        contractId = await askForInput('Contract ID (default:uuidv4)', uuidv4());
                        image = await askForInput('Image: 1=ubuntu(default) | 2=nodejs', "1");
                        if (image != "1" && image != "2") {
                            console.error('Invalid image. (Should be "1" or "2").')
                            break;
                        }

                        sendToAgent(JSON.stringify({
                            id: uuidv4(),
                            type: 'create',
                            owner_pubkey: 'ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50',
                            contract_id: contractId,
                            image: (image == "1" ? "ubt.20.04" : "ubt.20.04-njs.14")
                        }));
                        break;
                    case 'initiate':
                        containerName = await askForInput('Container Name');
                        role = await askForInput('Role: validator(default) | observer', "validator");
                        if (role != 'validator' && role != 'observer') {
                            console.error('Invalid role. (Should be "validator" or "observer").')
                            break;
                        }

                        history = await askForInput('History <{full|custom},max_primary_shards,max_raw_shards> (custom,1,1)', "custom,1,1");
                        split = [];
                        if (history) {
                            split = history.split(',');
                            if (split.length == 0 || split.length == 0 > 3) {
                                console.error('Invalid history.')
                                break;
                            }
                            else if (split[0] != 'full' && split[0] != 'custom') {
                                console.error('Invalid history. (Should be "full" or "custom").')
                                break;
                            }
                        }
                        peers = await askForInput('Comma seperated Peer List <host1:port1>,<host2:port2>,...');
                        unl = await askForInput('Comma seperated UNL <pubkey1>,<pubkey2>,...');
                        sendToAgent(JSON.stringify({
                            id: uuidv4(),
                            type: 'initiate',
                            container_name: containerName,
                            peers: peers ? peers.split(',') : [],
                            unl: unl ? unl.split(',') : [],
                            role: role,
                            history: split.length > 0 ? split[0] : '',
                            max_primary_shards: split.length > 1 ? parseInt(split[1]) : '',
                            max_raw_shards: split.length > 2 ? parseInt(split[2]) : ''
                        }));
                        break;
                    case 'destroy':
                        containerName = await askForInput('Container Name');
                        sendToAgent(JSON.stringify({
                            id: uuidv4(),
                            type: 'destroy',
                            container_name: containerName
                        }))
                        break;
                    case 'start':
                        containerName = await askForInput('Container Name');
                        sendToAgent(JSON.stringify({
                            id: uuidv4(),
                            type: 'start',
                            container_name: containerName
                        }))
                        break;
                    case 'stop':
                        containerName = await askForInput('Container Name');
                        sendToAgent(JSON.stringify({
                            id: uuidv4(),
                            type: 'stop',
                            container_name: containerName
                        }))
                        break;

                    default:
                        console.error('Invalid command. Only valid [create, initiate, destroy, start and stop]');
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
        let output = execSync(`${cliPath} json '${msg}'`, { stdio: 'pipe' });
        let message = Buffer.from(output).toString();
        message = JSON.parse(message.substring(0, message.length - 2)); // Skipping the \n from the result.
        console.log('Received: ', message);
        res && res.status((message.content && typeof message.content == 'string' && message.content.endsWith("error")) ? 500 : 200).send(message);
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
    app.post("/create", (req, res) => {
        const id = uuidv4();
        const msg = {
            id,
            type: 'create',
            owner_pubkey: req.body.owner_pubkey,
            contract_id: (req.body.contract_id === "") ? uuidv4() : req.body.contract_id,
            image: req.body.image ? req.body.image : "ubt.20.04"
        };
        sendToAgent(JSON.stringify(msg), res);
    });
    app.post("/initiate", (req, res) => {
        const id = uuidv4();
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
        const id = uuidv4();
        const msg = {
            id,
            type: 'start',
            container_name: req.body.container_name
        };
        sendToAgent(JSON.stringify(msg), res);
    });
    app.post("/stop", (req, res) => {
        const id = uuidv4();
        const msg = {
            id,
            type: 'stop',
            container_name: req.body.container_name
        };
        sendToAgent(JSON.stringify(msg), res);
    });
    app.post("/destroy", (req, res) => {
        const id = uuidv4();
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
