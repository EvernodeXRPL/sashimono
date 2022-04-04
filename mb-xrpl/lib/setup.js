
const https = require('https');
const { appenv } = require('./appenv');
const evernode = require('evernode-js-client');
const fs = require('fs');
const { SqliteDatabase } = require('./sqlite-handler');


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
            address: json.account.address,
            secret: json.account.secret
        };
    }

    #getConfig() {
        if (!fs.existsSync(appenv.CONFIG_PATH))
            throw `Config file does not exist at ${appenv.CONFIG_PATH}`;
        const config = JSON.parse(fs.readFileSync(appenv.CONFIG_PATH).toString());

        // Validate lease amount.
        if (config.xrpl.leaseAmount && typeof config.xrpl.leaseAmount === 'string') {
            try {
                config.xrpl.leaseAmount = parseFloat(config.xrpl.leaseAmount);
            }
            catch {
                throw "Lease amount should be a numerical value.";
            }
        }

        if (config.xrpl.leaseAmount && config.xrpl.leaseAmount < 0)
            throw "Lease amount should be a positive value";

        return config;
    }

    #saveConfig(cfg) {
        fs.writeFileSync(appenv.CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 }); // Set file permission so only current user can read/write.
    }

    newConfig(address = "", secret = "", registryAddress = "", leaseAmount = 0) {
        this.#saveConfig({
            version: appenv.MB_VERSION,
            xrpl: { address: address, secret: secret, registryAddress: registryAddress, leaseAmount: leaseAmount }
        });
    }

    async generateBetaHostAccount(registryAddress, domain) {

        evernode.Defaults.set({
            registryAddress: registryAddress
        });

        const acc = await this.#generateFaucetAccount();

        // Prepare host account.
        {
            console.log(`Preparing host account:${acc.address} (domain:${domain} registry:${registryAddress})`);
            const hostClient = new evernode.HostClient(acc.address, acc.secret);
            await hostClient.connect();

            // Sometimes we may get 'account not found' error from rippled when some servers in the testnet cluster
            // haven't still updated the ledger. In such cases, we retry several times before giving up.
            {
                let attempts = 0;
                while (attempts >= 0) {
                    try {
                        await hostClient.prepareAccount(domain);
                        break;
                    }
                    catch (err) {
                        if (err.data?.error === 'actNotFound' && ++attempts <= 5) {
                            console.log("actNotFound - retrying...")
                            // Wait and retry.
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            continue;
                        }
                        throw err;
                    }
                }
            }

            // Get beta EVRs from foundation to host account.
            {
                console.log("Requesting beta EVRs...");
                await hostClient.xrplAcc.makePayment(hostClient.config.foundationAddress,
                    evernode.XrplConstants.MIN_XRP_AMOUNT,
                    evernode.XrplConstants.XRP,
                    null,
                    [{ type: 'giftBetaEvr', format: '', data: '' }]);

                // Keep watching our EVR balance.
                let attempts = 0;
                while (attempts >= 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    const balance = await hostClient.getEVRBalance();
                    if (balance === '0') {
                        if (++attempts <= 20)
                            continue;
                        throw "EVR funds not received within timeout.";
                    }
                    break;
                }
            }

            await hostClient.disconnect();
        }

        return acc;
    }

    async register(countryCode, cpuMicroSec, ramKb, swapKb, diskKb, totalInstanceCount, description) {
        console.log("Registering host...");
        const acc = this.#getConfig().xrpl;
        evernode.Defaults.set({
            registryAddress: acc.registryAddress
        });

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Sometimes we may get 'tecPATH_DRY' error from rippled when some servers in the testnet cluster
        // haven't still updated the ledger. In such cases, we retry several times before giving up.
        let attempts = 0;
        while (attempts >= 0) {
            try {
                await hostClient.register(countryCode, cpuMicroSec,
                    Math.floor((ramKb + swapKb) / 1024), Math.floor(diskKb / 1024), totalInstanceCount, description.replace('_', ' '));

                // Create lease offers.
                console.log("Creating lease offers for the hosts...");
                const leaseAmount = acc.leaseAmount ? acc.leaseAmount : parseFloat(hostClient.config.purchaserTargetPrice); // in EVRs.
                for (let i = 0; i < totalInstanceCount; i++) {
                    await hostClient.offerLease(i, leaseAmount, appenv.TOS_HASH);
                    console.log(`Created lease offer ${i + 1} of ${totalInstanceCount}.`);
                }

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
        const acc = this.#getConfig().xrpl;
        evernode.Defaults.set({
            registryAddress: acc.registryAddress
        });

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();
        await this.burnMintedNfts(hostClient.xrplAcc);
        await hostClient.deregister();
        await hostClient.disconnect();
    }

    async regInfo(isBasic) {
        const acc = this.#getConfig().xrpl;
        console.log(`Registry address: ${acc.registryAddress}`);
        console.log(`Host account address: ${acc.address}`);

        if (!isBasic) {
            evernode.Defaults.set({
                registryAddress: acc.registryAddress
            });

            try {
                const hostClient = new evernode.HostClient(acc.address, acc.secret);
                await hostClient.connect();
                console.log('Retrieving EVR balance...');
                const evrBalance = await hostClient.getEVRBalance();
                console.log(`EVR balance: ${evrBalance}`);
                console.log('Retrieving reg info...');
                const hostInfo = await hostClient.getRegistration();
                if (hostInfo) {
                    console.log(`NFT: ${hostInfo.nfTokenId}`);
                }
                else {
                    await hostClient.disconnect();
                    throw 'Host is not registered';
                }
                await hostClient.disconnect();
            }
            catch {
                throw 'EVR balance: [Error occured when retrieving EVR balance]';
            }
        }
    }

    // Upgrades existing message board data to the new version.
    async upgrade() {

        // Do a simple version change in the config.
        // In the future we could have real upgrade/data migration logic here.
        const cfg = this.#getConfig();
        cfg.version = appenv.MB_VERSION;
        this.#saveConfig(cfg);

        await Promise.resolve(); // async placeholder.
    }

    // Burn the host minted NFTs at the de-registration
    async burnMintedNfts(xrplAcc) {

        // This local initialization can be changed according to the DB access requirement
        const db = new SqliteDatabase(appenv.DB_PATH);
        const leaseTable = appenv.DB_TABLE_NAME;

        db.open();

        try {

            // Burning unsold NFTs
            const unsoldHostingNfts = (await xrplAcc.getNfts()).filter(n => n.URI.startsWith(evernode.EvernodeConstants.LEASE_NFT_PREFIX_HEX));

            for (const nft of unsoldHostingNfts) {
                await xrplAcc.burnNft(nft.TokenID);
                console.log(`Burnt unsold hosting NFT (${nft.TokenID}) of ${xrplAcc.address} account`);
            }

            // Burning sold NFTs
            const instances = (await db.getValues(leaseTable)).filter(i => (i.status === "Acquired" || i.status === "Extended"));

            for (const instance of instances) {
                // As currently this burning option is not working (The ability of an issuer to burn a minted token, if it has the tfBurnable flag)
                //await xrplAcc.burnNft(instance.container_name);
                console.log(`Burnt sold hosting NFT (${instance.container_name}) of ${instance.tenant_xrp_address} tenant account`);
            }
        }
        finally {
            db.close();
        }
    }
}

module.exports = {
    Setup
}