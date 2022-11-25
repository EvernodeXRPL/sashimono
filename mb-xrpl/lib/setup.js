
const https = require('https');
const { appenv } = require('./appenv');
const evernode = require('evernode-js-client');
const fs = require('fs');
const { SqliteDatabase } = require('./sqlite-handler');
const { ConfigHelper } = require('./config-helper');

function setEvernodeDefaults(registryAddress, rippledServer) {
    evernode.Defaults.set({
        registryAddress: registryAddress,
        rippledServer: rippledServer || appenv.DEFAULT_RIPPLED_SERVER
    });
}

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

        // If Hooks TEST NET is used.
        return {
            address: json.address,
            secret: json.secret
        };

        // If NFT DEV NET is used.
        // return {
        //     address: json.account.address,
        //     secret: json.account.secret
        // };
    }

    #getConfig(readSecret = true) {
        return ConfigHelper.readConfig(appenv.CONFIG_PATH, readSecret ? appenv.SECRET_CONFIG_PATH : null);
    }

    #saveConfig(cfg) {
        ConfigHelper.writeConfig(cfg, appenv.CONFIG_PATH, appenv.SECRET_CONFIG_PATH);
    }

    newConfig(address = "", secret = "", registryAddress = "", leaseAmount = 0, rippledServer = null) {
        this.#saveConfig({
            version: appenv.MB_VERSION,
            xrpl: {
                address: address,
                secret: secret,
                registryAddress: registryAddress,
                rippledServer: rippledServer || appenv.DEFAULT_RIPPLED_SERVER,
                leaseAmount: leaseAmount
            }
        });
    }

    async generateBetaHostAccount(rippledServer, registryAddress, domain) {

        setEvernodeDefaults(registryAddress, rippledServer);

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

    async register(countryCode, cpuMicroSec, ramKb, swapKb, diskKb, totalInstanceCount, cpuModel, cpuCount, cpuSpeed, description, emailAddress) {
        console.log("Registering host...");

        let cpuModelFormatted = cpuModel.replaceAll('_', ' ');
        const acc = this.#getConfig().xrpl;
        setEvernodeDefaults(acc.registryAddress, acc.rippledServer);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Sometimes we may get 'tecPATH_DRY' error from rippled when some servers in the testnet cluster
        // haven't still updated the ledger. In such cases, we retry several times before giving up.
        let attempts = 0;
        while (attempts >= 0) {
            try {
                await hostClient.register(countryCode, cpuMicroSec,
                    Math.floor((ramKb + swapKb) / 1000), Math.floor(diskKb / 1000), totalInstanceCount, cpuModelFormatted.substring(0, 40), cpuCount, cpuSpeed, description.replaceAll('_', ' '), emailAddress);

                // Create lease offers.
                console.log("Creating lease offers for instance slots...");
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
        setEvernodeDefaults(acc.registryAddress, acc.rippledServer);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();
        await this.burnMintedNfts(hostClient.xrplAcc);
        await hostClient.deregister();
        await hostClient.disconnect();
    }

    async regInfo(isBasic) {
        const acc = this.#getConfig(false).xrpl;
        console.log(`Registry address: ${acc.registryAddress}`);
        console.log(`Host account address: ${acc.address}`);

        if (!isBasic) {
            setEvernodeDefaults(acc.registryAddress, acc.rippledServer);

            try {
                const hostClient = new evernode.HostClient(acc.address);
                await hostClient.connect();

                const [evrBalance, hostInfo] = await Promise.all([hostClient.getEVRBalance(), hostClient.getRegistration()]);
                if (hostInfo) {
                    console.log(`Registration NFT: ${hostInfo.nfTokenId}`);
                }
                else {
                    await hostClient.disconnect();
                    throw 'Host is not registered';
                }
                console.log(`EVR balance: ${evrBalance}`);

                await hostClient.disconnect();
            }
            catch {
                throw 'Error occured when retrieving account info.';
            }
        }
    }

    // Upgrades existing message board data to the new version.
    async upgrade() {

        // Do a simple version change in the config.
        const cfg = this.#getConfig();
        cfg.version = appenv.MB_VERSION;

        // Fill missing fields.
        if (!cfg.xrpl.rippledServer)
            cfg.xrpl.rippledServer = appenv.DEFAULT_RIPPLED_SERVER

        this.#saveConfig(cfg);

        await Promise.resolve(); // async placeholder.
    }

    // Burn the host minted NFTs at the de-registration.
    async burnMintedNfts(xrplAcc) {
        // Get unsold NFTs.
        const nfts = (await xrplAcc.getNfts()).filter(n => n.URI.startsWith(evernode.EvernodeConstants.LEASE_NFT_PREFIX_HEX))
            .map(o => { return { nfTokenId: o.NFTokenID, ownerAddress: xrplAcc.address }; });

        // Get sold NFTs.
        // We check for db existance since db is created by message board (not setup).
        const dbPath = appenv.DB_PATH;
        if (fs.existsSync(dbPath)) {
            // This local initialization can be changed according to the DB access requirement.
            const db = new SqliteDatabase(appenv.DB_PATH);
            const leaseTable = appenv.DB_TABLE_NAME;

            db.open();

            try {
                // We check for table existance since table is created by message board (not setup).
                if (db.isTableExists(leaseTable)) {
                    nfts.push(...(await db.getValues(leaseTable)).filter(i => (i.status === "Acquired" || i.status === "Extended"))
                        .map(o => { return { nfTokenId: o.container_name, ownerAddress: o.tenant_xrp_address }; }))
                }
            }
            finally {
                db.close();
            }
        }


        for (const nft of nfts) {
            const sold = nft.ownerAddress !== xrplAcc.address;
            await xrplAcc.burnNft(nft.nfTokenId, sold ? nft.ownerAddress : null);
            console.log(`Burnt ${sold ? 'sold' : 'unsold'} hosting NFT (${nft.nfTokenId}) of ${nft.ownerAddress + (sold ? ' tenant' : '')} account`);
        }
    }
}

module.exports = {
    Setup
}