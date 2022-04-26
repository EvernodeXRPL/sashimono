const process = require('process');
const logger = require('./lib/logger');
const { appenv } = require('./lib/appenv');
const { Setup } = require('./lib/setup');
const { MessageBoard } = require('./lib/message-board');

async function main() {

    if (process.argv[2] === 'version') {
        console.log(appenv.MB_VERSION);
    }

    try {
        if (process.argv.length >= 3) {
            if (process.argv.length >= 3 && process.argv[2] === 'new') {
                new Setup().newConfig(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
            }
            else if (process.argv.length === 6 && process.argv[2] === 'betagen') {
                const registryAddress = process.argv[3];
                const domain = process.argv[4];
                const leaseAmount = process.argv[5];
                const setup = new Setup();
                const acc = await setup.generateBetaHostAccount(registryAddress, domain);
                setup.newConfig(acc.address, acc.secret, registryAddress, parseFloat(leaseAmount));
            }
            else if (process.argv.length === 10 && process.argv[2] === 'register') {
                await new Setup().register(process.argv[3], parseInt(process.argv[4]), parseInt(process.argv[5]),
                    parseInt(process.argv[6]), parseInt(process.argv[7]), parseInt(process.argv[8]), process.argv[9]);
            }
            else if (process.argv.length === 3 && process.argv[2] === 'deregister') {
                await new Setup().deregister();
            }
            else if (process.argv.length === 3 && process.argv[2] === 'reginfo') {
                await new Setup().regInfo(false);
            }
            else if (process.argv.length === 4 && process.argv[2] === 'reginfo' && process.argv[3] === 'basic') {
                await new Setup().regInfo(true);
            }
            else if (process.argv.length === 3 && process.argv[2] === 'upgrade') {
                await new Setup().upgrade();
            }
            else if (process.argv[2] === 'help') {
                console.log(`Usage:
        node index.js - Run message board.
        node index.js version - Print version.
        node index.js new [address] [secret] [registryAddress] [leaseAmount] - Create new config files.
        node index.js betagen [registryAddress] [domain or ip] [leaseAmount] - Generate beta host account and populate the configs.
        node index.js register [countryCode] [cpuMicroSec] [ramKb] [swapKb] [diskKb] [totalInstanceCount] [description] - Register the host on Evernode.
        node index.js deregister - Deregister the host from Evernode.
        node index.js reginfo - Display Evernode registration info.
        node index.js upgrade - Upgrade message board data.
        node index.js help - Print help.`);
            }
            else {
                throw "Invalid args.";
            }
        }
        else {
            // Logs are formatted with the timestamp and a log file will be created inside log directory.
            logger.init(appenv.LOG_PATH, appenv.FILE_LOG_ENABLED);

            console.log('Starting the Evernode xrpl message board.' + (appenv.IS_DEV_MODE ? ' (in dev mode)' : ''));
            console.log('Data dir: ' + appenv.DATA_DIR);
            console.log('Using Sashimono cli: ' + appenv.SASHI_CLI_PATH);

            const mb = new MessageBoard(appenv.CONFIG_PATH, appenv.SECRET_CONFIG_PATH, appenv.DB_PATH, appenv.SASHI_CLI_PATH);
            await mb.init();
        }

    }
    catch (err) {
        // If error is a RippledError show internal error message, Otherwise show err.
        console.log(err?.data?.error_message || err);
        console.log("Evernode xrpl message board exiting with error.");
        process.exit(1);
    }
}

main().catch(console.error);