const process = require('process');
const logger = require('./lib/logger');
const { appenv } = require('./lib/appenv');
const { Setup } = require('./lib/setup');
const { MessageBoard } = require('./lib/message-board');
const { GovernanceManager } = require('./lib/governance-manager');

async function main() {

    if (process.argv[2] === 'version') {
        console.log(appenv.MB_VERSION);
    }

    try {
        if (process.argv.length >= 3) {
            if (process.argv.length >= 9 && process.argv[2] === 'new') {
                const accountAddress = process.argv[3];
                const accountSecret = process.argv[4];
                const governorAddress = process.argv[5];
                const domain = process.argv[6];
                const leaseAmount = process.argv[7];
                const rippledServer = process.argv[8];
                const fallbackRippledServers = process.argv[9].split(" ").filter(Boolean);
                const ipv6Subnet = (process.argv[10] === '-') ? null : process.argv[10];
                const ipv6NetInterface = (process.argv[11] === '-') ? null : process.argv[11];
                const setup = new Setup();
                const acc = await setup.setupHostAccount(accountAddress, accountSecret, rippledServer, governorAddress, domain, fallbackRippledServers);
                setup.newConfig(acc.address, acc.secret, governorAddress, parseFloat(leaseAmount), rippledServer, fallbackRippledServers, ipv6Subnet, ipv6NetInterface);
            }
            else if (process.argv.length === 7 && process.argv[2] === 'betagen') {
                const governorAddress = process.argv[3];
                const domain = process.argv[4];
                const leaseAmount = process.argv[5];
                const rippledServer = process.argv[6];
                const setup = new Setup();
                const acc = await setup.generateBetaHostAccount(rippledServer, governorAddress, domain);
                setup.newConfig(acc.address, acc.secret, governorAddress, parseFloat(leaseAmount), rippledServer);
            }
            else if (process.argv.length >= 13 && process.argv[2] === 'register') {
                await new Setup().register(process.argv[3], parseInt(process.argv[4]), parseInt(process.argv[5]),
                    parseInt(process.argv[6]), parseInt(process.argv[7]), parseInt(process.argv[8]), process.argv[9], parseInt(process.argv[10]), parseInt(process.argv[11]), process.argv[12], process.argv[13]);
            }
            else if (process.argv.length >= 3 && process.argv[2] === 'transfer') {
                (process.argv[3]) ? await new Setup().transfer(process.argv[3]) : await new Setup().transfer();
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
            else if (process.argv.length === 4 && process.argv[2] === 'upgrade') {
                await new Setup().upgrade(process.argv[3]);
            }
            else if ((process.argv.length === 8) && process.argv[2] === 'reconfig') {
                if (process.argv[5] == '-') process.argv[5] = null;
                if (process.argv[6] == '-') process.argv[6] = null;
                if (process.argv[7] == '-') process.argv[7] = null;

                await new Setup().changeConfig(process.argv[3], process.argv[5], process.argv[4], process.argv[6], process.argv[7]);
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
            else if (process.argv[2] === 'help') {
                console.log(`Usage:
        node index.js - Run message board.
        node index.js version - Print version.
        node index.js new [address] [secret] [governorAddress] [leaseAmount] [rippledServer] [ipv6Subnet] [ipv6Interface] - Create new config files.
        node index.js betagen [governorAddress] [domain or ip] [leaseAmount] [rippledServer] - Generate beta host account and populate the configs.
        node index.js register [countryCode] [cpuMicroSec] [ramKb] [swapKb] [diskKb] [totalInstanceCount] [description] - Register the host on Evernode.
        node index.js transfer [transfereeAddress] - Initiate a transfer.
        node index.js deregister - Deregister the host from Evernode.
        node index.js reginfo - Display Evernode registration info.
        node index.js upgrade [governorAddress] - Upgrade message board data.
        node index.js reconfig [leaseAmount] [totalInstanceCount] [rippledServer] - Update message board configuration.
        node index.js delete [containerName] - Delete an instance and recreate the lease offer
        node index.js governance [command] [args] - Governance handling.
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

            const mb = new MessageBoard(appenv.CONFIG_PATH, appenv.SECRET_CONFIG_PATH, appenv.DB_PATH, appenv.SASHI_CLI_PATH, appenv.SASHI_DB_PATH, appenv.SASHI_CONFIG_PATH);
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