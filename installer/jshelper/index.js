// This script helps the evernode setup with xrpl information validations.

const evernode = require("evernode-js-client");
const process = require("process");
const fs = require("fs");
const ip6addr = require('ip6addr');

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
        const xrplApi = new evernode.XrplApi(rippledUrl, { autoReconnect: false });
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

        const xrplApi = new evernode.XrplApi(rippledUrl, { autoReconnect: false });
        await xrplApi.connect();

        const hostClient = new evernode.HostClient(accountAddress, null, {
            rippledServer: rippledUrl,
            governorAddress: governorAddress,
            xrplApi: xrplApi
        });

        if (!await hostClient.xrplAcc.exists())
            return { success: false, result: "Account not found." };

        await hostClient.connect();
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

        const xrplApi = new evernode.XrplApi(rippledUrl, { autoReconnect: false });
        await xrplApi.connect();

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

        const xrplApi = new evernode.XrplApi(rippledUrl, { autoReconnect: false });
        await xrplApi.connect();

        evernode.Defaults.set({
            rippledServer: rippledUrl,
            governorAddress: governorAddress,
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

        const xrplApi = new evernode.XrplApi(rippledUrl, { autoReconnect: false });
        await xrplApi.connect();

        const hostClient = new evernode.HostClient(accountAddress, accountSecret, {
            rippledServer: rippledUrl,
            governorAddress: governorAddress,
            xrplApi: xrplApi
        });

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