const process = require('process');
const fs = require('fs');

let appenv = {
    IS_DEV_MODE: process.env.REPUTATIOND_DEV === "1",
    FILE_LOG_ENABLED: process.env.REPUTATIOND_FILE_LOG === "1",
    DATA_DIR: process.env.REPUTATIOND_DATA_DIR || __dirname,
    DATA_DIR: process.env.REPUTATIOND_DATA_DIR || __dirname
}

appenv = {
    ...appenv,
    CONFIG_PATH: appenv.DATA_DIR + '/reputationd.cfg',
    LOG_PATH: appenv.DATA_DIR + '/log/reputationd.log',
    REPUTATIOND_VERSION: '0.8.2',
    MB_XRPL_CONFIG_PATH: (appenv.IS_DEV_MODE ? "../build/" : path.join(appenv.DATA_DIR, '../')) + "mb-xrpl/mb-xrpl.cfg",
}

const getSecretPath = () => {
    return fs.existsSync(appenv.CONFIG_PATH) ? JSON.parse(fs.readFileSync(appenv.CONFIG_PATH).toString()).xrpl.secretPath : "";
}

appenv = { ...appenv, SECRET_CONFIG_PATH: getSecretPath() }

Object.freeze(appenv);

module.exports = {
    appenv
}