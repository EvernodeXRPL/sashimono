const process = require('process');
const path = require('path');

let appenv = {
    IS_DEV_MODE: process.env.REPUTATIOND_DEV === "1",
    FILE_LOG_ENABLED: process.env.REPUTATIOND_FILE_LOG === "1",
    DATA_DIR: process.env.REPUTATIOND_DATA_DIR || __dirname,
    INSTANCE_IMAGE: 'evernode/sashimono:hp.test-ubt.20.04-njs.20',
}

appenv = {
    ...appenv,
    CONFIG_PATH: appenv.DATA_DIR + '/reputationd.cfg',
    LOG_PATH: appenv.DATA_DIR + '/log/reputationd.log',
    REPUTATIOND_VERSION: '0.8.3',
    REPUTATIOND_SCHEDULER_INTERVAL_SECONDS: 2,
    CONTRACT_PATH: appenv.IS_DEV_MODE ? "../evernode-reputation-contract/dist" : (appenv.DATA_DIR + "/reputation-contract"),
    MB_XRPL_CONFIG_PATH: path.join(appenv.DATA_DIR, '../') + "mb-xrpl/mb-xrpl.cfg",
}

Object.freeze(appenv);

module.exports = {
    appenv
}