const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const readLine = require('readline');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require("child_process");

// Generate tls keys if not found.
if (!fs.existsSync('./tlskey.pem')) {
    console.log("TLS key files not detected. Generating..");
    execSync("openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout tlskey.pem -out tlscert.pem -subj \"/C=SA/ST=SA/L=SA/O=SA/CN=SA\"");
    console.log("New tls key files generated.")
}

const server = https.createServer({
    cert: fs.readFileSync('./tlscert.pem'),
    key: fs.readFileSync('./tlskey.pem')
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.on('message', (msg) => {
        try {
            console.log('Received: ', JSON.parse(Buffer.from(msg).toString()));
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
    wss.close();
    rl.close();
    server.close()
});

const sendToAll = (msg) => {
    wss.clients.forEach(ws => {
        ws.send(msg);
    });
}

const askForInput = (label) => {
    return new Promise(resolve => {
        rl.question(`${label}? `, (input) => {
            resolve(input);
        })
    })
}

server.listen(5000, () => {
    console.log(`wss://localhost:${server.address().port}`)
    console.log("Ready to accept inputs.");

    const inputPump = () => {
        rl.question('', async (inp) => {

            if (inp.length > 0) {
                if (wss.clients.size == 0) {
                    console.log('No Sashimano agents connected yet.')
                }
                else {
                    switch (inp) {
                        case 'create':
                            contractId = await askForInput('Contract ID (optional)');
                            if (contractId == "")
                                contractId = uuidv4();
                                
                            sendToAll(JSON.stringify({
                                id: uuidv4(),
                                type: 'create',
                                owner_pubkey: 'ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50',
                                contract_id: contractId
                            }));
                            break;
                        case 'initiate':
                            containerName = await askForInput('Container Name');
                            role = await askForInput('Role <validator> or <observer>');
                            if (role && role != 'validator' && role != 'observer') {
                                console.error('Invalid role. (Should be "validator" or "observer").')
                                break;
                            }
                            history = await askForInput('History <mode{full|custom},max_primary_shards{number},max_raw_shards{number}>');
                            split = [];
                            if (history)
                            {
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
                            sendToAll(JSON.stringify({
                                id: uuidv4(),
                                type: 'initiate',
                                owner_pubkey: 'ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50',
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
                            sendToAll(JSON.stringify({
                                id: uuidv4(),
                                type: 'destroy',
                                owner_pubkey: 'ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50',
                                container_name: containerName
                            }))
                            break;
                        case 'start':
                            containerName = await askForInput('Container Name');
                            sendToAll(JSON.stringify({
                                id: uuidv4(),
                                type: 'start',
                                owner_pubkey: 'ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50',
                                container_name: containerName
                            }))
                            break;
                        case 'stop':
                            containerName = await askForInput('Container Name');
                            sendToAll(JSON.stringify({
                                id: uuidv4(),
                                type: 'stop',
                                owner_pubkey: 'ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50',
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

