const process = require('process');
const fs = require('fs');

let appenv = {
    FILE_LOG_ENABLED: process.env.REPUTATIOND_FILE_LOG === "1",
    DATA_DIR: process.env.REPUTATIOND_DATA_DIR || __dirname,
    DATA_DIR: process.env.REPUTATIOND_DATA_DIR || __dirname,
    INSTANCE_IMAGE: 'evernode/sashimono:hp.0.6.4-ubt.20.04-njs.20',
}

appenv = {
    ...appenv,
    CONFIG_PATH: appenv.DATA_DIR + '/reputationd.cfg',
    LOG_PATH: appenv.DATA_DIR + '/log/reputationd.log',
    REPUTATIOND_VERSION: '0.8.2',
    REPUTATIOND_SCHEDULER_INTERVAL_SECONDS: 2,
    CONTRACT_PATH: appenv.DATA_DIR + "reputation-contract",
    MB_XRPL_CONFIG_PATH: path.join(appenv.DATA_DIR, '../') + "mb-xrpl/mb-xrpl.cfg",
}

const getSecretPath = () => {
    return fs.existsSync(appenv.CONFIG_PATH) ? JSON.parse(fs.readFileSync(appenv.CONFIG_PATH).toString()).xrpl.secretPath : "";
}

appenv = { ...appenv, SECRET_CONFIG_PATH: getSecretPath() }

Object.freeze(appenv);

module.exports = {
    appenv
}