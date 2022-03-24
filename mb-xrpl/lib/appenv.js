const process = require('process');

let appenv = {
    IS_DEV_MODE: process.env.MB_DEV === "1",
    FILE_LOG_ENABLED: process.env.MB_FILE_LOG === "1",
    DATA_DIR: process.env.MB_DATA_DIR || __dirname,
    FAUCET_URL: process.env.MB_FAUCET_URL || "https://faucet-nft.ripple.com/accounts"
}

appenv = {
    ...appenv,
    CONFIG_PATH: appenv.DATA_DIR + '/mb-xrpl.cfg',
    LOG_PATH: appenv.DATA_DIR + '/log/mb-xrpl.log',
    DB_PATH: appenv.DATA_DIR + '/mb-xrpl.sqlite',
    DB_TABLE_NAME: 'redeem_ops',
    DB_UTIL_TABLE_NAME: 'util_data',
    LAST_WATCHED_LEDGER: 'last_watched_ledger',
    ACQUIRE_LEASE_TIMEOUT_THRESHOLD: 0.8,
    ACQUIRE_LEASE_WAIT_TIMEOUT_THRESHOLD: 0.4,
    SASHI_CLI_PATH: appenv.IS_DEV_MODE ? "../build/sashi" : "/usr/bin/sashi",
    MB_VERSION: '0.0.5',
}
Object.freeze(appenv);

module.exports = {
    appenv
}