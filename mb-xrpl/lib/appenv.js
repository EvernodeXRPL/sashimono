const process = require('process');

let appenv = {
    IS_DEV_MODE: process.env.MB_DEV === "1",
    FILE_LOG_ENABLED: process.env.MB_FILE_LOG === "1",
    DATA_DIR: process.env.MB_DATA_DIR || __dirname,
    FAUCET_URL: process.env.MB_FAUCET_URL || "https://hooks-testnet-v2.xrpl-labs.com/newcreds",
    DEFAULT_RIPPLED_SERVER: 'wss://hooks-testnet-v2.xrpl-labs.com'
}

appenv = {
    ...appenv,
    CONFIG_PATH: appenv.DATA_DIR + '/mb-xrpl.cfg',
    SECRET_CONFIG_PATH: appenv.DATA_DIR + '/secret.cfg',
    LOG_PATH: appenv.DATA_DIR + '/log/mb-xrpl.log',
    DB_PATH: appenv.DATA_DIR + '/mb-xrpl.sqlite',
    DB_TABLE_NAME: 'leases',
    DB_UTIL_TABLE_NAME: 'util_data',
    LAST_WATCHED_LEDGER: 'last_watched_ledger',
    ACQUIRE_LEASE_TIMEOUT_THRESHOLD: 0.8,
    ACQUIRE_LEASE_WAIT_TIMEOUT_THRESHOLD: 0.4,
    SASHI_CLI_PATH: appenv.IS_DEV_MODE ? "../build/sashi" : "/usr/bin/sashi",
    MB_VERSION: '0.5.0',
    TOS_HASH: '757A0237B44D8B2BBB04AE2BAD5813858E0AECD2F0B217075E27E0630BA74314' // This is the sha256 hash of TOS text.
}
Object.freeze(appenv);

module.exports = {
    appenv
}