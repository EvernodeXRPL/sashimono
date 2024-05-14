const process = require('process');
// Uncaught Exception Handling.
process.on('uncaughtException', (err) => {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    console.error('Unhandled exception occurred:', err?.message);
    console.error('Stack trace:', err?.stack);
    console.log("MB_CLI_EXITED");
    process.exit(1);
});

// Unhandled Rejection Handling.
process.on('unhandledRejection', (reason, promise) => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    console.log("MB_CLI_EXITED");
    process.exit(1);
});

const logger = require('./lib/logger');
const { appenv } = require('./lib/appenv');
const { Setup } = require('./lib/setup');
const { MessageBoard } = require('./lib/message-board');
const { GovernanceManager } = require('./lib/governance-manager');

async function main() {

    if (process.argv[2] === 'version') {
        console.log(appenv.MB_VERSION);
    }

    if (process.argv.length >= 3) {
        try {
            if (process.argv.length >= 15 && process.argv[2] === 'new') {
                const accountAddress = process.argv[3];
                const accountSecretPath = process.argv[4];
                const governorAddress = process.argv[5];
                const domain = process.argv[6];
                const leaseAmount = process.argv[7];
                const rippledServer = process.argv[8];
                const emailAddress = process.argv[9];
                const affordableExtraFee = process.argv[10];
                const ipv6Subnet = (process.argv[11] === '-') ? null : process.argv[11];
                const ipv6NetInterface = (process.argv[12] === '-') ? null : process.argv[12];
                const network = (process.argv[13] === '-') ? appenv.NETWORK : process.argv[13];
                const fallbackRippledServers = (process.argv[14] === '-') ? null : process.argv[14].split(',');
                const setup = new Setup();
                setup.newConfig(accountAddress, accountSecretPath, governorAddress, parseFloat(leaseAmount), rippledServer, ipv6Subnet, ipv6NetInterface, network, parseInt(affordableExtraFee), emailAddress, fallbackRippledServers);

                if (appenv.IS_DEV_MODE) {
                    await setup.prepareHostAccount(domain);
                }
            }
            else if (process.argv.length >= 2 && process.argv[2] === 'check-reg') {
                if (process.argv.length > 3) {
                    await new Setup().checkRegistration(process.argv[3], parseInt(process.argv[4]), parseInt(process.argv[5]),
                        parseInt(process.argv[6]), parseInt(process.argv[7]), parseInt(process.argv[8]), process.argv[9], parseInt(process.argv[10]), parseInt(process.argv[11]), process.argv[12], process.argv[13]);
                }
                else {
                    await new Setup().checkRegistration();
                }
            }
            else if (process.argv.length >= 2 && process.argv[2] === 'check-balance') {
                await new Setup().checkBalance();
            }
            else if (process.argv.length >= 4 && process.argv[2] === 'wait-for-funds') {
                await new Setup().waitForFunds(process.argv[3], parseFloat(process.argv[4]));
            }
            else if (process.argv.length >= 3 && process.argv[2] === 'prepare') {
                await new Setup().prepareHostAccount(process.argv[3]);
            }
            else if (process.argv.length >= 2 && process.argv[2] === 'accept-reg-token') {
                await new Setup().acceptRegToken();
            }
            else if (process.argv.length >= 13 && process.argv[2] === 'register') {
                await new Setup().register(process.argv[3], parseInt(process.argv[4]), parseInt(process.argv[5]),
                    parseInt(process.argv[6]), parseInt(process.argv[7]), parseInt(process.argv[8]), process.argv[9], parseInt(process.argv[10]), parseInt(process.argv[11]), process.argv[12], process.argv[13]);
            }
            else if (process.argv.length >= 3 && process.argv[2] === 'mint-leases') {
                await new Setup().mintLeases(process.argv[3]);
            }
            else if (process.argv.length >= 2 && process.argv[2] === 'offer-leases') {
                await new Setup().offerLeases();
            }
            else if (process.argv.length >= 2 && process.argv[2] === 'burn-leases') {
                await new Setup().burnLeases();
            }
            else if (process.argv.length >= 3 && process.argv[2] === 'transfer') {
                (process.argv[3]) ? await new Setup().transfer(process.argv[3]) : await new Setup().transfer();
            }
            else if (process.argv.length >= 3 && process.argv[2] === 'deregister') {
                await new Setup().deregister(process.argv[3]);
            }
            else if (process.argv.length === 3 && process.argv[2] === 'reginfo') {
                await new Setup().regInfo(false);
            }
            else if (process.argv.length === 4 && process.argv[2] === 'reginfo' && process.argv[3] === 'basic') {
                await new Setup().regInfo(true);
            }
            else if (process.argv.length >= 3 && process.argv[2] === 'upgrade') {
                await new Setup().upgrade();
            }
            else if ((process.argv.length === 10) && process.argv[2] === 'reconfig') {
                if (process.argv[5] == '-') process.argv[5] = null;
                if (process.argv[6] == '-') process.argv[6] = null;
                if (process.argv[7] == '-') process.argv[7] = null;
                if (process.argv[8] == '-') process.argv[8] = null;
                if (process.argv[9] == '-') process.argv[9] = null;

                await new Setup().changeConfig(process.argv[3], process.argv[5], process.argv[4], process.argv[6], process.argv[7], process.argv[8], process.argv[9] != null ? process.argv[9].split(',') : null);
            }
            else if (process.argv.length === 4 && process.argv[2] === 'delete') {
                await new Setup().deleteInstance(process.argv[3]);
            }
            else if (process.argv.length === 3 && process.argv[2] === 'hostinfo') {
                await new Setup().hostInfo();
            }
            else if (process.argv.length === 4 && process.argv[2] === 'update') {
                await new Setup().update(process.argv[3]);
            }
            else if (process.argv.length >= 4 && process.argv[2] === 'governance') {
                await GovernanceManager.handleCommand(process.argv[3], ...process.argv.slice(4));
            }
            else if (process.argv.length >= 3 && process.argv[2] === 'regkey') {
                await new Setup().setRegularKey(process.argv[3]);
            }
            else if (process.argv[2] === 'help') {
                console.log(`Usage:
        node index.js - Run message board.
        node index.js version - Print version.
        node index.js new [address] [secretPath] [governorAddress] [domain or ip] [leaseAmount] [rippledServer] [ipv6Subnet] [ipv6Interface] [network] - Create new config files.
        node index.js check-reg - Check registration.
        node index.js check-balance - Check EVR balance.
        node index.js wait-for-funds [currencyType] [expectedBalance] - Wait until the funds are received.
        node index.js accept-reg-token - Accept registration token if there're any.
        node index.js register [countryCode] [cpuMicroSec] [ramKb] [swapKb] [diskKb] [totalInstanceCount] [cpuModelName] [cpuCount] [cpuMhz] [emailAddress] [description] [network] - Register the host on Evernode.
        node index.js mint-leases [instanceCount] - Mint leases for the instances.
        node index.js offer-leases - Offer all minted leases.
        node index.js burn-leases - Burn all minted leases.
        node index.js transfer [transfereeAddress] - Initiate a transfer.
        node index.js deregister - Deregister the host from Evernode.
        node index.js reginfo - Display Evernode registration info.
        node index.js upgrade [governorAddress] - Upgrade message board data.
        node index.js reconfig [leaseAmount] [totalInstanceCount] [rippledServer] [ipv6Subnet] [ipv6NetInterface] [affordableExtraFee] [fallbackRippledServers] - Update message board configuration.
        node index.js delete [containerName] - Delete an instance and recreate the lease offer
        node index.js governance [command] [args] - Governance handling.
        node index.js regkey [regularKey] - Regular key management.
        node index.js help - Print help.`);
            }
            else {
                throw "Invalid args.";
            }
        }
        catch (err) {
            process.removeAllListeners('uncaughtException');
            process.removeAllListeners('unhandledRejection');

            // If error is a RippledError show internal error message, Otherwise show err.
            console.log(err?.data?.error_message || err);
            console.log("MB_CLI_EXITED");
            process.exit(1);
        }
    }
    else {
        try {
            // Logs are formatted with the timestamp and a log file will be created inside log directory.
            logger.init(appenv.LOG_PATH, appenv.FILE_LOG_ENABLED);

            console.log('Starting the Evernode Xahau message board.' + (appenv.IS_DEV_MODE ? ' (in dev mode)' : ''));
            console.log('Data dir: ' + appenv.DATA_DIR);
            console.log('Using Sashimono cli: ' + appenv.SASHI_CLI_PATH);

            const mb = new MessageBoard(appenv.CONFIG_PATH, appenv.DB_PATH, appenv.SASHI_CLI_PATH, appenv.SASHI_DB_PATH, appenv.SASHI_CONFIG_PATH, appenv.REPUTATIOND_CONFIG_PATH);
            await mb.init();
        }
        catch (err) {
            process.removeAllListeners('uncaughtException');
            process.removeAllListeners('unhandledRejection');

            // If error is a RippledError show internal error message, Otherwise show err.
            console.log(err?.data?.error_message || err);
            console.log("Evernode Xahau message board exiting with error.");
            console.log("MB_CLI_EXITED");
            process.exit(1);
        }
    }
}

main().then(() => {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');

    console.log("MB_CLI_SUCCESS");
}).catch((e) => {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');

    console.error(e);
    console.log("MB_CLI_EXITED");
    process.exit(1);
});
