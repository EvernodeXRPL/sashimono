
const https = require('https');
const { appenv } = require('./appenv');

class Setup {

    #httpPost(url) {
        return new Promise((resolve, reject) => {
            const req = https.request(url, { method: 'POST' }, (resp) => {
                let data = '';
                resp.on('data', (chunk) => data += chunk);
                resp.on('end', () => {
                    if (resp.statusCode == 200)
                        resolve(data);
                    else
                        reject(data);
                });
            })

            req.on("error", reject);
            req.on('timeout', () => reject('Request timed out.'))
            req.end()
        })
    }

    async #generateFaucetAccount() {
        console.log("Generating faucet account...");
        const resp = await this.#httpPost(appenv.FAUCET_URL);
        const json = JSON.parse(resp);
        return {
            address: json.address,
            secret: json.secret
        };
    }

    #getRandomToken() {
        const randomChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let result = '';
        for (var i = 0; i < 3; i++) {
            result += randomChars.charAt(Math.floor(Math.random() * randomChars.length));
        }
        return result;
    }

    #getConfigAccount() {
        if (!fs.existsSync(appenv.CONFIG_PATH))
            throw `Config file does not exist at ${appenv.CONFIG_PATH}`;
        return JSON.parse(fs.readFileSync(appenv.CONFIG_PATH).toString()).xrpl;
    }

    async #giftEvers(hostAddress) {
        console.log("Sending EVRs...");

        // Sometimes we may get error from func execution when some rippled servers in the testnet cluster
        // haven't still updated the ledger. In such cases, we retry several times before giving up.
        let attempts = 0;
        while (attempts >= 0) {
            try {
                await this.#httpPost(appenv.EVR_SEND_URL + hostAddress);
                break;
            }
            catch (err) {
                if (++attempts <= 5)
                    continue;

                throw err;
            }
        }
    }

    async generateBetaHostAccount(hookAddress) {

        evernode.Defaults.set({
            hookAddress: hookAddress,
            rippledServer: appenv.RIPPLED_URL
        });

        const acc = await this.#generateFaucetAccount();
        acc.token = this.#getRandomToken();

        // Prepare host account.
        {
            console.log(`Preparing host account:${acc.address} (token:${acc.token} hook:${hookAddress})`);
            const hostClient = new evernode.HostClient(acc.address, acc.secret);
            await hostClient.connect();

            // Sometimes we may get 'account not found' error from rippled when some servers in the testnet cluster
            // haven't still updated the ledger. In such cases, we retry several times before giving up.
            let attempts = 0;
            while (attempts >= 0) {
                try {
                    await hostClient.prepareAccount();
                    break;
                }
                catch (err) {
                    if (err.data.error === 'actNotFound' && ++attempts <= 5) {
                        console.log("actNotFound - retrying...")
                        // Wait and retry.
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    }
                    throw err;
                }
            }

            await hostClient.disconnect();
        }

        // Send EVRs from hook to host account.
        {
            await this.#giftEvers(acc.address);
        }

        return acc;
    }

    newConfig(address = "", secret = "", hookAddress = "", token = "") {
        if (fs.existsSync(appenv.CONFIG_PATH))
            throw `Config file already exists at ${appenv.CONFIG_PATH}`;

        const configJson = JSON.stringify({
            version: MB_VERSION,
            xrpl: { address: address, secret: secret, hookAddress: hookAddress, token: token }
        }, null, 2);
        fs.writeFileSync(appenv.CONFIG_PATH, configJson, { mode: 0o600 }); // Set file permission so only current user can read/write.
    }

    async register(countryCode, cpuMicroSec, ramKb, swapKb, diskKb, description) {
        console.log("Registering host...");
        const acc = this.#getConfigAccount();
        evernode.Defaults.set({
            hookAddress: acc.hookAddress,
            rippledServer: appenv.RIPPLED_URL
        });

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Sometimes we may get 'tecPATH_DRY' error from rippled when some servers in the testnet cluster
        // haven't still updated the ledger. In such cases, we retry several times before giving up.
        let attempts = 0;
        while (attempts >= 0) {
            try {
                await hostClient.register(acc.token, countryCode, cpuMicroSec,
                    Math.floor((ramKb + swapKb) / 1024), Math.floor(diskKb / 1024), description.replace('_', ' '));
                break;
            }
            catch (err) {
                if (err.code === 'tecPATH_DRY' && ++attempts <= 5) {
                    console.log("tecPATH_DRY - retrying...")
                    // Wait and retry.
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    continue;
                }
                throw err;
            }
        }

        await hostClient.disconnect();
    }

    async deregister() {
        console.log("Deregistering host...");
        const acc = this.#getConfigAccount();
        evernode.Defaults.set({
            hookAddress: acc.hookAddress,
            rippledServer: appenv.RIPPLED_URL
        });

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();
        await hostClient.deregister();
        await hostClient.disconnect();
    }

    async regInfo() {
        const acc = this.#getConfigAccount();
        evernode.Defaults.set({
            hookAddress: acc.hookAddress,
            rippledServer: appenv.RIPPLED_URL
        });

        console.log(`Host account address: ${acc.address}`);
        console.log(`Hosting token: ${acc.token}`);
        try {
            const hostClient = new evernode.HostClient(acc.address, acc.secret);
            console.log('Retrieving EVR balance...')
            await hostClient.connect();
            const evrBalance = await hostClient.getEVRBalance();
            console.log(`EVR balance: ${evrBalance}`);
            await hostClient.disconnect();
        }
        catch {
            console.log('EVR balance: [Error occured when retrieving EVR balance]');
        }
        console.log(`Hook address: ${acc.hookAddress}`);
    }
}

module.exports = {
    Setup
}