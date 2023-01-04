// This script helps the evernode setup with xrpl information validations.

const evernode = require("evernode-js-client");
const process = require("process");
const fs = require("fs");

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
        const xrplApi = new evernode.XrplApi(rippledUrl);
        await xrplApi.connect();
        await xrplApi.disconnect();
        return { success: true };
    },
    'validate-account': async (args) => {
        checkParams(args, 3);
        const rippledUrl = args[0];
        const registryAddress = args[1];
        const accountAddress = args[2];

        const hostClient = new evernode.HostClient(accountAddress, null, {
            rippledServer: rippledUrl,
            registryAddress: registryAddress,
        });

        if (!await hostClient.xrplAcc.exists())
            return { success: false, result: "Account not found." };

        await hostClient.connect();
        if (await hostClient.isRegistered())
            return { success: false, result: "Host already registered." };

        // Check whether pending transfer exists.
        const isTransferPending = await hostClient.isTransferee();
        const minEverBalance = isTransferPending ? 1 : hostClient.config.hostRegFee;
        const currentBalance = await hostClient.getEVRBalance();
        if (currentBalance < minEverBalance)
            return { success: false, result: `The account needs minimum balance of ${minEverBalance} EVR. Current balance is ${currentBalance} EVR.` }

        await hostClient.disconnect();
        return { success: true };
    },
    'validate-keys': async (args) => {
        checkParams(args, 2);
        const accountAddress = args[0];
        const accountSecret = args[1];
        const xrplAcc = new evernode.XrplAccount(accountAddress, accountSecret);
        return { success: await xrplAcc.isValidSecret() };
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