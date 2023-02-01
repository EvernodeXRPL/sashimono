const evernode = require("evernode-js-client");
const process = require("process");
const fs = require("fs");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = DATA_DIR + '/mb-xrpl.cfg';
const SECRET_CONFIG_PATH = DATA_DIR + '/secret.cfg';

const getConfig = () => {
    if (!fs.existsSync(CONFIG_PATH))
        throw `Config file does not exist at ${CONFIG_PATH}`;
    else if (!fs.existsSync(SECRET_CONFIG_PATH))
        throw `Config file does not exist at ${SECRET_CONFIG_PATH}`;

        let config = JSON.parse(fs.readFileSync(CONFIG_PATH).toString());
        const secretCfg = JSON.parse(fs.readFileSync(SECRET_CONFIG_PATH).toString());
        config.xrpl = { ...config.xrpl, ...secretCfg.xrpl };

        return config;
}

const propose = async (hashFilePath, shortName) => {
    if (!hashFilePath)
        throw `Hash file param cannot be empty.`;
    else if (!fs.existsSync(hashFilePath))
        throw `Hash file ${hashFilePath} does not exist.`;
    else if (!shortName)
        throw `Short name cannot be empty.`;

    const hashes = fs.readFileSync(hashFilePath).toString();

    const config = getConfig();

    const xrplApi = new evernode.XrplApi(config.xrpl.rippledServer);
    evernode.Defaults.set({
        governorAddress: config.xrpl.governorAddress,
        xrplApi: xrplApi
    })
    await xrplApi.connect();
    const hostClient = new evernode.HostClient(config.xrpl.address, config.xrpl.secret);

    try {
        await hostClient.connect();
        await hostClient.proposeHookCandidate(hashes, shortName);
    } finally {
        await hostClient.disconnect();
        await xrplApi.disconnect();
    }
}

const app = async () => {
    const command = process.argv[2];
    const params = process.argv.slice(3);

    if (command == "propose" && params.length == 2)
        await propose(params[0], params[1]);
    else {
        console.error("Supported governance commands:\n propose <hash_file> <short_name> - Propose new hook candidate");
        process.exit(2);
    }
}

app().then(() => {
    process.exit(0);
}).catch((e) => {
    console.error(e);
    process.exit(1);
});