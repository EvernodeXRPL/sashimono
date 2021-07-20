const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const readLine = require('readline');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require("child_process");
const express = require('express');

// Generate tls keys if not found.
if (!fs.existsSync('./tlskey.pem')) {
    console.log("TLS key files not detected. Generating..");
    execSync("openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout tlskey.pem -out tlscert.pem -subj \"/C=SA/ST=SA/L=SA/O=SA/CN=SA\"");
    console.log("New tls key files generated.")
}
let restServer, websocketServer;
const reqMap = {}; // Store response object vs message id to deliver response back when the SA responses.

/**
 * Interactive interface to get message from the command line and sent it to all the connected agents.
*/
const interatctiveInterface = async () => {
    const server = https.createServer({
        cert: fs.readFileSync('./tlscert.pem'),
        key: fs.readFileSync('./tlskey.pem')
    });

    websocketServer = new WebSocket.Server({ server });

    websocketServer.on('connection', (ws) => {
        ws.on('message', (msg) => {
            try {
                const message = JSON.parse(Buffer.from(msg).toString());
                console.log('Received: ', message);
                reqMap[message.reply_for] && reqMap[message.reply_for].status(message.type == "error" ? 500 : 200).send(message);

            } catch (error) {
                console.error("Error occured in json parsing." + error);
            }
        });
    });

    // start listening for stdin
    const rl = readLine.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    // On ctrl + c we should close SA connection gracefully.
    rl.on('SIGINT', () => {
        console.log('SIGINT received...');
        websocketServer.close();
        rl.close();
        server.close();
        restServer && restServer.close();
    });

    const askForInput = (label, defaultValue) => {
        return new Promise(resolve => {
            rl.question(`${label}? `, (input) => {
                resolve(input && input.length > 0 ? input : defaultValue);
            })
        })
    }

    server.listen(5000, () => {
        console.log(`wss://localhost:${server.address().port}`)
        console.log("Ready to accept inputs.");

        const inputPump = () => {
            rl.question('', async (inp) => {

                if (inp.length > 0) {
                    if (websocketServer.clients.size == 0) {
                        console.log('No Sashimano agents connected yet.')
                    }
                    else {
                        switch (inp) {
                            case 'create':
                                contractId = await askForInput('Contract ID (default:uuidv4)', uuidv4());
                                image = await askForInput('Image: 1=ubuntu(default) | 2=nodejs', "1");
                                if (image != "1" && image != "2") {
                                    console.error('Invalid image. (Should be "1" or "2").')
                                    break;
                                }

                                sendToAllAgents(JSON.stringify({
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
                                sendToAllAgents(JSON.stringify({
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
                                sendToAllAgents(JSON.stringify({
                                    id: uuidv4(),
                                    type: 'destroy',
                                    container_name: containerName
                                }))
                                break;
                            case 'start':
                                containerName = await askForInput('Container Name');
                                sendToAllAgents(JSON.stringify({
                                    id: uuidv4(),
                                    type: 'start',
                                    container_name: containerName
                                }))
                                break;
                            case 'stop':
                                containerName = await askForInput('Container Name');
                                sendToAllAgents(JSON.stringify({
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

                }

                inputPump();
            })
        }
        inputPump();
    });
}

const sendToAllAgents = (msg) => {
    websocketServer && websocketServer.clients.forEach(ws => {
        ws.send(msg);
    });
}

const webServerProtocol = (process.env.SSL === "true") ? "https" : "http";
const webServerPort = 5001;

const restApi = async () => {
    const app = express();
    app.use(express.json());
    // Handle errors before forward to processing.
    app.use((req, res, next) => {
        if (websocketServer.clients.size == 0) {
            console.log('No Sashimano agents connected yet.')
            res.status(404).send('No Sashimano agents connected yet.');
        }
        else {
            next();
        }
    });
    app.post("/status", (req, res) => {
        res.send("Message board running...");
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
        reqMap[id] = res;
        sendToAllAgents(JSON.stringify(msg));
    });
    app.post("/initiate", (req, res) => {
        const id = uuidv4();
        const msg = {
            id,
            type: 'initiate',
            owner_pubkey: req.body.owner_pubkey,
            container_name: req.body.container_name,
            peers: req.body.peers ? req.body.peers: [],
            unl: req.body.unl ? req.body.unl: [],
            role: req.body.role? req.body.role: 'validator',
            history: req.body.history? req.body.history: 'custom',
            max_primary_shards: req.body.max_primary_shards? req.body.max_primary_shards: 1,
            max_raw_shards: req.body.max_raw_shards? req.body.max_raw_shards: 1
        };
        reqMap[id] = res;
        sendToAllAgents(JSON.stringify(msg));
    });
    app.post("/start", (req, res) => {
        const id = uuidv4();
        const msg = {
            id,
            type: 'start',
            owner_pubkey: req.body.owner_pubkey,
            container_name: req.body.container_name
        };
        reqMap[id] = res;
        sendToAllAgents(JSON.stringify(msg));
    });
    app.post("/stop", (req, res) => {
        const id = uuidv4();
        const msg = {
            id,
            type: 'stop',
            owner_pubkey: req.body.owner_pubkey,
            container_name: req.body.container_name
        };
        reqMap[id] = res;
        sendToAllAgents(JSON.stringify(msg));
    });
    app.post("/destroy", (req, res) => {
        const id = uuidv4();
        const msg = {
            id,
            type: 'destroy',
            owner_pubkey: req.body.owner_pubkey,
            container_name: req.body.container_name
        };
        reqMap[id] = res;
        sendToAllAgents(JSON.stringify(msg));
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
    await restApi();
    await interatctiveInterface();
})();
