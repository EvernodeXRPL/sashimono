// This script helps the evernode setup with xrpl information validations.

const evernode = require("evernode-js-client");
const process = require("process");
const fs = require("fs");
const ip6addr = require('ip6addr');
const keypairs = require('ripple-keypairs');
const http = require('http');
const crypto = require('crypto');
const { appenv } = require("../../mb-xrpl/lib/appenv");

let NETWORK = appenv.NETWORK;

function checkParams(args, count) {
    for (let i = 0; i < count; i++) {
        if (!args[i]) throw "Params not specified.";
    }
}

// Every function corresponds to a command provided on the shell.
// Each function must be async and return { success: <boolean>, result: <string (optional)> }
// If any exception is thrown it will be considered as a failure (non-zero exit code).
const funcs = {
    'validate-server': async (args) => {
        checkParams(args, 1);
        const rippledUrl = args[0];
        await evernode.Defaults.useNetwork(NETWORK);
        evernode.Defaults.set({
            rippledServer: rippledUrl
        });
        const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
        await xrplApi.connect();
        await xrplApi.disconnect();
        return { success: true };
    },

    'validate-account': async (args) => {
        checkParams(args, 3);
        const rippledUrl = args[0];
        const governorAddress = args[1];
        const accountAddress = args[2];
        const validateFor = args[3] || "register";

        await evernode.Defaults.useNetwork(NETWORK);

        evernode.Defaults.set({
            rippledServer: rippledUrl,
            governorAddress: governorAddress
        });

        const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
        await xrplApi.connect();

        evernode.Defaults.set({
            xrplApi: xrplApi
        });

        const hostClient = new evernode.HostClient(accountAddress, null);

        if (!await hostClient.xrplAcc.exists())
            return { success: false, result: "Account not found." };

        await hostClient.connect();

        if (validateFor === "register" || validateFor === "re-register") {
            // Check whether is there any missed NFT sell offers
            try {
                const registryAcc = new evernode.XrplAccount(hostClient.config.registryAddress, null);
                const regUriToken = await hostClient.getRegistrationUriToken();

                if (!regUriToken) {
                    const regInfo = await hostClient.getHostInfo(accountAddress);

                    if (regInfo) {
                        const sellOffer = (await registryAcc.getURITokens()).find(o => o.index == regInfo.uriTokenId && o.Amount);

                        if (sellOffer) {
                            await hostClient.disconnect();
                            await xrplApi.disconnect();
                            return { success: true };
                        }
                    }
                }

            } catch (e) {
                await hostClient.disconnect();
                await xrplApi.disconnect();
                return { success: false, result: 'Error occured in missed sell offers check.' };
            }
        }

        const registered = await hostClient.isRegistered();
        // For register validation the host should not be registered in evernode.
        // For other validations host should be registered in evernode.
        if (validateFor === "register") {
            if (registered)
                return { success: false, result: "Host is already registered." };
        }
        else if (!registered)
            return { success: false, result: "Host is not registered." };

        // Check whether pending transfer exists.
        const isTransferPending = await hostClient.isTransferee();

        // For register validation check the available balance enough for transfer and non transfer registrations.
        // For other validations there should not be a pending transfer for the host.
        if (validateFor === "register") {
            const minEverBalance = isTransferPending ? 1 : hostClient.config.hostRegFee;
            const currentBalance = await hostClient.getEVRBalance();
            if (currentBalance < minEverBalance)
                return { success: false, result: `The account needs minimum balance of ${minEverBalance} EVR. Current balance is ${currentBalance} EVR.` }
        }
        else if (isTransferPending)
            return { success: false, result: "There's a pending transfer for this host." };

        await hostClient.disconnect();
        await xrplApi.disconnect();
        return { success: true };
    },

    'validate-keys': async (args) => {
        checkParams(args, 3);
        const rippledUrl = args[0];
        const accountAddress = args[1];
        const accountSecret = args[2];

        await evernode.Defaults.useNetwork(NETWORK);

        evernode.Defaults.set({
            rippledServer: rippledUrl
        });

        const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
        await xrplApi.connect();

        evernode.Defaults.set({
            xrplApi: xrplApi
        });

        const xrplAcc = new evernode.XrplAccount(accountAddress, accountSecret, {
            xrplApi: xrplApi
        });

        const validKeys = await xrplAcc.hasValidKeyPair()
        await xrplApi.disconnect();

        return validKeys ? { success: true } : { success: false, result: "Given account address and secret do not match." };
    },

    'access-evernode-cfg': async (args) => {
        checkParams(args, 3);
        const rippledUrl = args[0];
        const governorAddress = args[1];
        const configName = args[2];

        await evernode.Defaults.useNetwork(NETWORK);

        evernode.Defaults.set({
            rippledServer: rippledUrl,
            governorAddress: governorAddress
        });

        const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
        await xrplApi.connect();

        evernode.Defaults.set({
            xrplApi: xrplApi
        });

        const governorClient = await evernode.HookClientFactory.create(evernode.HookTypes.governor);
        await governorClient.connect();
        const config = await governorClient.config;

        await governorClient.disconnect();
        await xrplApi.disconnect();

        return { success: true, result: typeof config[configName] === 'object' ? JSON.stringify(config[configName]) : `${config[configName]}` };
    },

    'transfer': async (args) => {
        checkParams(args, 4);
        const rippledUrl = args[0];
        const governorAddress = args[1];
        const accountAddress = args[2];
        const accountSecret = args[3];
        const transfereeAddress = args[4];

        await evernode.Defaults.useNetwork(NETWORK);

        evernode.Defaults.set({
            rippledServer: rippledUrl,
            governorAddress: governorAddress
        });

        const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
        await xrplApi.connect();

        evernode.Defaults.set({
            xrplApi: xrplApi
        });

        const hostClient = new evernode.HostClient(accountAddress, accountSecret);

        if (!await hostClient.xrplAcc.exists())
            return { success: false, result: "Account not found." };

        await hostClient.connect();

        await hostClient.transfer(transfereeAddress || accountAddress);

        await hostClient.disconnect();
        await xrplApi.disconnect();

        return { success: true };
    },

    'ip6-getsubnet': async (args) => {
        checkParams(args, 1);

        // Expecting an ipv6 subnet CIDR string as the argument.
        const [ip, prefixLen] = args[0].split('/');

        if (ip && prefixLen && !isNaN(prefixLen)) {

            try {
                // This will return the normalized abbreviated subnet CIDR notation.
                const cidr = ip6addr.createCIDR(ip, parseInt(prefixLen));
                return { success: true, result: cidr.toString() };
            }
            catch {
                // Silent catch so that we don't log exceptions to console.
                // This will be treated as ip validation failure.
            }
        }

        return { success: false };
    },

    'ip6-nested-subnet': async (args) => {
        checkParams(args, 2);

        const primarySubnet = args[0];
        const nestedSubnet = args[1];

        // Expecting ipv6 subnet CIDR strings as the arguments.
        const [primaryIp, primaryPrefixLen] = primarySubnet.split('/');
        const [nestedIp, nestedPrefixLen] = nestedSubnet.split('/');

        if (primaryIp && primaryPrefixLen && !isNaN(primaryPrefixLen) &&
            nestedIp && nestedPrefixLen && !isNaN(nestedPrefixLen)) {

            try {

                const primaryCidr = ip6addr.createCIDR(primaryIp, parseInt(primaryPrefixLen));
                const nestedCidr = ip6addr.createCIDR(nestedIp, parseInt(nestedPrefixLen));

                // Check whether nested cidr address range is inside primary cidr address range.
                if (primaryCidr.first().compare(nestedCidr.first()) <= 0 &&
                    primaryCidr.last().compare(nestedCidr.last()) >= 0) {

                    // This will return the normalized abbreviated nested subnet CIDR notation.
                    return { success: true, result: nestedCidr.toString() };
                }
            }
            catch {
                // Silent catch so that we don't log exceptions to console.
                // This will be treated as ip validation failure.
            }
        }

        return { success: false };
    },

    'check-acc-condition': async (args) => {
        checkParams(args, 3);
        const rippledUrl = args[0];
        const governorAddress = args[1];
        const accountAddress = args[2];

        await evernode.Defaults.useNetwork(NETWORK);

        evernode.Defaults.set({
            rippledServer: rippledUrl,
            governorAddress: governorAddress
        });

        const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
        await xrplApi.connect();

        evernode.Defaults.set({
            xrplApi: xrplApi
        });

        const hostClient = new evernode.HostClient(accountAddress, null);
        const terminateConnections = async () => {
            await hostClient.disconnect();
            await xrplApi.disconnect();
        }

        try {
            // In order to handle the account not found issue via catch block.
            await hostClient.connect();
            await terminateConnections();
            return { success: true, result: 'RC-ACTIVE' }

        } catch (err) {
            await terminateConnections();

            if ((err.data?.error === 'actNotFound'))
                return { success: true, result: "RC-NON-ACTIVE" };
            return { success: false, result: "Error occurred in account condition check." };
        }
    },

    'check-balance': async (args) => {
        checkParams(args, 5);
        const rippledUrl = args[0];
        const governorAddress = args[1];
        const accountAddress = args[2];
        const tokenType = args[3];
        const expectedBalance = args[4];

        const WAIT_PERIOD = 120; // seconds

        await evernode.Defaults.useNetwork(NETWORK);

        evernode.Defaults.set({
            rippledServer: rippledUrl,
            governorAddress: governorAddress
        });

        try {
            const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
            await xrplApi.connect();

            evernode.Defaults.set({
                xrplApi: xrplApi
            });

            const hostClient = new evernode.HostClient(accountAddress, null);
            const terminateConnections = async () => {
                await hostClient.disconnect();
                await xrplApi.disconnect();
            }

            let attempts = 0;
            let balance = 0;
            while (attempts >= 0) {
                try {
                    // In order to handle the account not found issue via catch block.
                    await hostClient.connect();

                    await new Promise(resolve => setTimeout(resolve, 1000));
                    if (tokenType === 'NATIVE')
                        balance = Number((await hostClient.xrplAcc.getInfo()).Balance) / 1000000;
                    else
                        balance = Number(await hostClient.getEVRBalance());

                    if (balance < expectedBalance) {
                        if (++attempts <= WAIT_PERIOD)
                            continue;

                        await terminateConnections();
                        return { success: false, result: "Funds not received within timeout." };
                    }

                    break;
                } catch (err) {
                    if (err.data?.error === 'actNotFound' && ++attempts <= WAIT_PERIOD) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }
                    await terminateConnections();
                    return { success: false, result: (err.data?.error === 'actNotFound') ? "Funds not received within timeout." : "Error occurred in account balance check." };
                }
            }

            await terminateConnections();
            return { success: true, result: `${balance}` };
        } catch {
            return { success: false, result: "Error occurred in websocket connection." };
        }
    },

    'generate-account': async (args) => {
        let seed = null;
        if (args[0])
            seed = args[0];
        else
            seed = keypairs.generateSeed({ algorithm: "ecdsa-secp256k1" });

        const keypair = keypairs.deriveKeypair(seed);
        const createdKeypair = {
            address: keypairs.deriveAddress(keypair.publicKey),
            secret: seed
        }
        return { success: true, result: typeof createdKeypair === 'object' ? JSON.stringify(createdKeypair) : `${createdKeypair}` };
    },

    'prepare-host': async (args) => {
        checkParams(args, 4);
        const rippledUrl = args[0];
        const governorAddress = args[1];
        const accountAddress = args[2];
        const accountSecret = args[3];
        // Optional
        const domain = args[4] ? args[4] : "";

        const WAIT_PERIOD = 120; // seconds

        await evernode.Defaults.useNetwork(NETWORK);

        evernode.Defaults.set({
            rippledServer: rippledUrl,
            governorAddress: governorAddress
        });

        const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
        await xrplApi.connect();

        evernode.Defaults.set({
            xrplApi: xrplApi
        });

        const hostClient = new evernode.HostClient(accountAddress, accountSecret);
        await hostClient.connect();

        const terminateConnections = async () => {
            await hostClient.disconnect();
            await xrplApi.disconnect();
        }

        {
            let attempts = 0;
            while (attempts >= 0) {
                try {
                    await hostClient.prepareAccount(domain);
                    break;
                }
                catch (err) {
                    if (err.data?.error === 'actNotFound' && ++attempts <= WAIT_PERIOD) {
                        // Wait and retry.
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }

                    await terminateConnections();
                    return { success: false, result: "Error occurred in account preparation." };
                }
            }
        }

        await terminateConnections();
        return { success: true };

    },

    // Starts an HTTP server on port 80 and check whether that's reachable via
    // the provided domain.
    'validate-domain': async (args) => {
        checkParams(args, 2);
        const domain = args[0];
        const port = parseInt(args[1]);
        const urlPath = "/" + crypto.randomBytes(16).toString('hex');
        const responseString = crypto.randomBytes(16).toString('hex');

        const server = http.createServer((req, res) => {
            if (req.url === urlPath) {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end(responseString + '\n');
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found\n');
            }
        });

        try {
            await new Promise((resolve, reject) => {
                server.on('error', function (e) {
                    // We assume this is an error when starting to listen.
                    reject("listen_error");
                });

                server.listen(port, () => {
                    // Server started. Now send a request via public domain.

                    const reqOptions = {
                        hostname: domain,
                        port: port,
                        path: urlPath,
                        method: "GET"
                    };

                    const req = http.request(reqOptions, (res) => {
                        let data = "";

                        res.on("data", (chunk) => {
                            data += chunk;
                        });

                        // request completion event.
                        res.on("end", () => {
                            server.close();
                            if (data.startsWith(responseString)) {
                                resolve();
                            } else {
                                // Return string does not match our responseString. Most probably response was
                                // sent by some other server. Not by us.
                                reject("domain_error")
                            }
                        });
                    });

                    req.on("error", (e) => {
                        server.close();
                        reject("domain_error")
                    });

                    req.setTimeout(3000, () => { // 3 second request timeout
                        req.destroy();
                        server.close();
                        reject("domain_error");
                    });

                    req.end();
                });
            });

            return { success: true, result: "ok" };

        } catch (errorCode) {
            return { success: false, result: errorCode };
        }
    },

    'compute-xah-requirement': async (args) => {
        checkParams(args, 2);
        const rippledUrl = args[0];
        const incReserveCount = Number(args[1]);

        await evernode.Defaults.useNetwork(NETWORK);

        evernode.Defaults.set({
            rippledServer: rippledUrl
        });

        try {
            const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
            await xrplApi.connect();

            evernode.Defaults.set({
                xrplApi: xrplApi
            });

            const serverInfo = await xrplApi.getServerInfo();
            if (serverInfo?.info?.validated_ledger) {
                const reserves = serverInfo.info.validated_ledger
                const estimate = (reserves?.reserve_base_native ?? reserves?.reserve_base_xrp) + (reserves?.reserve_inc_native ?? reserves?.reserve_inc_xrp) * incReserveCount;

                if (estimate > 0) {
                    await xrplApi.disconnect();
                    return { success: true, result: `${estimate}` };
                }
            }

            await xrplApi.disconnect();
            return { success: false, result: "Failed to retrieve the estimation." };


        } catch {
            return { success: false, result: "Error occurred in websocket connection." };
        }
    }

}

function handleResponse(resp) {

    if (!resp.result) resp.result = "-";

    // If RESPFILE env is specified, we write the result to that file insead of stdout.
    // This allows the setup script to read the command result directly from the RESPFILE.
    if (process.env.RESPFILE) fs.writeFileSync(process.env.RESPFILE, resp.result);
    else console.log(resp.result);

    // Setup script uses the exit code of this script to evaluate the result.
    process.exit(resp.success === true ? 0 : 1);
}

async function app() {

    try {
        const networkIdx = process.argv.findIndex(a => a.startsWith('network:'));
        if (networkIdx >= 0) {
            const sp = process.argv[networkIdx].split(':');
            if (sp.length > 1 && sp[1]) {
                NETWORK = sp[1];
                process.argv.splice(networkIdx, 1);
            }
        }

        const command = process.argv[2];
        if (!command)
            throw "Command not specified.";


        const resp = await funcs[command](process.argv.splice(3));
        if (!resp)
            throw "No response.";

        handleResponse(resp);
    }
    catch (e) {
        // Write the placeholder char to response file if specified.
        // Otherwise the reader process (setup script) will get stuck.
        if (process.env.RESPFILE) fs.writeFileSync(process.env.RESPFILE, "-");
        console.log(e);
        process.exit(1);
    }
}
app();