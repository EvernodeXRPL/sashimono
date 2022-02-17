process = require('process');

let appenv = {
    IS_DEV_MODE: process.env.MB_DEV === "1",
    FILE_LOG_ENABLED: process.env.MB_FILE_LOG === "1",
    RIPPLED_URL: process.env.MB_RIPPLED_URL || "wss://hooks-testnet.xrpl-labs.com",
    DATA_DIR: process.env.MB_DATA_DIR || __dirname,
    FAUCET_URL: process.env.MB_FAUCET_URL || "https://hooks-testnet.xrpl-labs.com/newcreds",
    EVR_SEND_URL: process.env.MB_EVR_SEND_URL || "https://func-hotpocket.azurewebsites.net/api/evrfaucet?code=pPUyV1q838ryrihA5NVlobVXj8ZGgn9HsQjGGjl6Vhgxlfha4/xCgQ==&action=fundhost&hostaddr=",
}

appenv = {
    ...appenv,
    CONFIG_PATH: appenv.DATA_DIR + '/mb-xrpl.cfg',
    LOG_PATH: appenv.DATA_DIR + '/log/mb-xrpl.log',
    DB_PATH: appenv.DATA_DIR + '/mb-xrpl.sqlite',
    DB_TABLE_NAME: 'redeem_ops',
    DB_UTIL_TABLE_NAME: 'util_data',
    LAST_WATCHED_LEDGER: 'last_watched_ledger',
    REDEEM_CREATE_TIMEOUT_THRESHOLD: 0.8,
    REDEEM_WAIT_TIMEOUT_THRESHOLD: 0.4,
    SASHI_CLI_PATH: appenv.IS_DEV_MODE ? "../build/sashi" : "/usr/bin/sashi",
    MB_VERSION: '1.0.0',
}
Object.freeze(appenv);

module.exports = {
    appenv
}