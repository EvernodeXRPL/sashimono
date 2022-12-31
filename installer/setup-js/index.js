const evernode = require("evernode-js-client");
const process = require("process");

const MSG_PREFIX = "EVMSG:";

function getXrplApi(url) {
    const xrplApi = new evernode.XrplApi(url, {
        xrplClientOptions: {
            connectionTimeout: 10000
        }
    });

    try {
        await xrplApi.connect();
    }
    catch (e) {
        throw `${MSG_PREFIX}Could not connect to ${url}`;
    }
}

const funcs = {
    'validate-server': (args) => {
        const rippledUrl = args[0];
        const xrplApi = await getXrplApi(rippledUrl);
        await xrplApi.disconnect();
        return { success: true };
    },
    'validate-account': (args) => {
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

        // TODO: Check whether pending transfer exists.
        // We need helper method for this in HostClient.
        const isTransferPending = false;

        const minEverBalance = isTransferPending ? 1 : hostClient.config.hostRegFee;
        const currentBalance = await hostClient.getEVRBalance();
        if (currentBalance < minEverBalance)
            return { success: false, result: `The account needs minimum balance of ${minEverBalance} EVR. Current balance is ${currentBalance} EVR.` }

        await hostClient.disconnect();
        return { success: true };
    },
    'validate-keys': (args) => {
        const accountAddress = args[0];
        const accountSecret = args[1];
        const xrplAcc = new evernode.XrplAccount(accountAddress, accountSecret);
        return { success: await xrplAcc.isValidSecret() };
    }
}

async function app() {

    const mode = process.argv[2];
    if (!mode)
        throw "Mode not specified.";

    try {
        const resp = await funcs[mode](process.argv.splice(3));
        if (resp) {
            resp.result && console.log(`${MSG_PREFIX}${resp.result}`);
            process.exit(resp.success === true ? 0 : 1);
        }
    }
    catch (e) {
        if (typeof e === "string" && e.startsWith(ERR_PREFIX))
            console.log(e);
    }
    process.exit(1);
}
app();