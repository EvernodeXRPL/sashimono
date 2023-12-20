const process = require('process');
const path = require('path');
const fs = require('fs');

let appenv = {
    IS_DEV_MODE: process.env.MB_DEV === "1",
    FILE_LOG_ENABLED: process.env.MB_FILE_LOG === "1",
    DATA_DIR: process.env.MB_DATA_DIR || __dirname
}

appenv = {
    ...appenv,
    CONFIG_PATH: appenv.DATA_DIR + '/mb-xrpl.cfg',
    GOVERNANCE_CONFIG_PATH: appenv.DATA_DIR + '/governance.cfg',
    LOG_PATH: appenv.DATA_DIR + '/log/mb-xrpl.log',
    DB_PATH: appenv.DATA_DIR + '/mb-xrpl.sqlite',
    DB_TABLE_NAME: 'leases',
    DB_UTIL_TABLE_NAME: 'util_data',
    SASHI_DB_PATH: (appenv.IS_DEV_MODE ? "../build/" : path.join(appenv.DATA_DIR, '../')) + "sa.sqlite",
    SASHI_CONFIG_PATH: (appenv.IS_DEV_MODE ? "../build/" : path.join(appenv.DATA_DIR, '../')) + "sa.cfg",
    SASHI_TABLE_NAME: 'instances',
    LAST_WATCHED_LEDGER: 'last_watched_ledger',
    ACQUIRE_LEASE_TIMEOUT_THRESHOLD: 0.8,
    ACQUIRE_LEASE_WAIT_TIMEOUT_THRESHOLD: 0.4,
    ORPHAN_PRUNE_SCHEDULER_INTERVAL_HOURS: 4,
    SASHIMONO_SCHEDULER_INTERVAL_SECONDS: 2,
    SASHI_CLI_PATH: appenv.IS_DEV_MODE ? "../build/sashi" : "/usr/bin/sashi",
    MB_VERSION: '0.8.0',
    TOS_HASH: '0801677EBCB2F76EF97D531549D8B27DB2C7A4A8EE7F60032AE40184247F0810', // This is the sha256 hash of EVERNODE-HOSTING-PRINCIPLES.pdf.
    NETWORK: 'mainnet'
}

const getSecretPath = () => {
    return fs.existsSync(appenv.CONFIG_PATH) ? JSON.parse(fs.readFileSync(appenv.CONFIG_PATH).toString()).xrpl.secretPath : "";
}

appenv = { ...appenv, SECRET_CONFIG_PATH: getSecretPath() }

Object.freeze(appenv);

module.exports = {
    appenv
}