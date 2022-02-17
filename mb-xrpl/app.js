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
            else if (process.argv.length === 4 && process.argv[2] === 'betagen') {
                const hookAddress = process.argv[3];
                const setup = new Setup();
                const acc = await setup.generateBetaHostAccount(hookAddress);
                setup.newConfig(acc.address, acc.secret, hookAddress, acc.token);
            }
            else if (process.argv.length === 9 && process.argv[2] === 'register') {
                await new Setup().register(process.argv[3], parseInt(process.argv[4]), parseInt(process.argv[5]),
                    parseInt(process.argv[6]), parseInt(process.argv[7]), process.argv[8]);
            }
            else if (process.argv.length === 3 && process.argv[2] === 'deregister') {
                await new Setup().deregister();
            }
            else if (process.argv.length === 3 && process.argv[2] === 'reginfo') {
                await new Setup().regInfo();
            }
            else if (process.argv[2] === 'help') {
                console.log(`Usage:
        node index.js - Run message board.
        node index.js version - Print version.
        node index.js new [address] [secret] [hookAddress] [token] - Create new config file.
        node index.js betagen [hookAddress] - Generate beta host account and populate config.
        node index.js register [countryCode] [cpuMicroSec] [ramKb] [swapKb] [diskKb] [description] - Register the host on Evernode.
        node index.js deregister - Deregister the host from Evernode.
        node index.js reginfo - Display Evernode registration info.
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
            console.log('Rippled server: ' + appenv.RIPPLED_URL);
            console.log('Using Sashimono cli: ' + appenv.SASHI_CLI_PATH);

            const mb = new MessageBoard(appenv.CONFIG_PATH, appenv.DB_PATH, appenv.SASHI_CLI_PATH, appenv.RIPPLED_URL);
            await mb.init();
        }

    }
    catch (err) {
        console.log(err);
        console.log("Evernode xrpl message board exiting with error.");
        process.exit(1);
    }
}

main().catch(console.error);