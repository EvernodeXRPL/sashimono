const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const readLine = require('readline');
const { v4: uuidv4 } = require('uuid');

const server = https.createServer({
    cert: fs.readFileSync('./tlscert.pem'),
    key: fs.readFileSync('./tlskey.pem')
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.on('message', (msg) => {
        console.log('Received: ', msg);
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

const askForContractId = () => {
    return new Promise(resolve => {
        rl.question('Contract Id? ', (contractId) => {
            resolve(contractId);
        })
    })
}

server.listen(8080, () => {
    console.log(`wss://localhost:${server.address().port}`)
    console.log("Ready to accept inputs.");

    const input_pump = () => {
        rl.question('', async (inp) => {

            if (inp.length > 0) {
                if (wss.clients.size == 0) {
                    console.log('No Sashimano agents connected yet.')
                }
                else {
                    switch (inp) {
                        case 'create':
                            sendToAll(JSON.stringify({
                                id: uuidv4(),
                                type: 'create',
                                ownerPubKey: 'ed7a4b931bdc5dd79b77a8b6ac293d998c123db42bb3ec2613'
                            }));
                            break;
                        case 'destroy':
                            contractId = await askForContractId();
                            sendToAll(JSON.stringify({
                                id: uuidv4(),
                                type: 'destroy',
                                ownerPubKey: 'ed7a4b931bdc5dd79b77a8b6ac293d998c123db42bb3ec2613',
                                contractId
                            }))

                            break;
                        case 'start':
                            contractId = await askForContractId();
                            sendToAll(JSON.stringify({
                                id: uuidv4(),
                                type: 'start',
                                ownerPubKey: 'ed7a4b931bdc5dd79b77a8b6ac293d998c123db42bb3ec2613',
                                contractId
                            }))
                            break;
                        case 'stop':
                            contractId = await askForContractId();
                            sendToAll(JSON.stringify({
                                id: uuidv4(),
                                type: 'stop',
                                ownerPubKey: 'ed7a4b931bdc5dd79b77a8b6ac293d998c123db42bb3ec2613',
                                contractId
                            }))
                            break;

                        default:
                            console.log('Invalid command. Only valid [create, destroy, start and stop]');
                            break;
                    }

                }

            }

            input_pump();
        })
    }
    input_pump();
});

