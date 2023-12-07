
const https = require('https');
const { appenv } = require('./appenv');
const evernode = require('evernode-js-client');
const fs = require('fs');
const { SqliteDatabase } = require('./sqlite-handler');
const { ConfigHelper } = require('./config-helper');
const { SashiCLI } = require('./sashi-cli');
const { UtilHelper } = require('./util-helper');

async function setEvernodeDefaults(network, governorAddress, rippledServer) {
    await evernode.Defaults.useNetwork(network || appenv.NETWORK);

    if (governorAddress)
        evernode.Defaults.set({
            governorAddress: governorAddress
        });

    if (rippledServer)
        evernode.Defaults.set({
            rippledServer: rippledServer
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

    #getConfig(readSecret = true) {
        return ConfigHelper.readConfig(appenv.CONFIG_PATH, readSecret ? appenv.SECRET_CONFIG_PATH : null);
    }

    #saveConfig(cfg) {
        ConfigHelper.writeConfig(cfg, appenv.CONFIG_PATH);
    }

    newConfig(address = "", secretPath = "", governorAddress = "", leaseAmount = 0, rippledServer = null, ipv6Subnet = null, ipv6NetInterface = null, network = "") {
        const baseConfig = {
            version: appenv.MB_VERSION,
            xrpl: {
                network: network,
                address: address,
                secretPath: secretPath,
                governorAddress: governorAddress,
                rippledServer: rippledServer || appenv.DEFAULT_RIPPLED_SERVER,
                leaseAmount: leaseAmount
            }
        };

        this.#saveConfig(ipv6NetInterface ? { ...baseConfig, networking: { ipv6: { subnet: ipv6Subnet, interface: ipv6NetInterface } } } : baseConfig);
    }

    async register(countryCode, cpuMicroSec, ramKb, swapKb, diskKb, totalInstanceCount, cpuModel, cpuCount, cpuSpeed, emailAddress, description) {
        console.log("Registering host...");
        let cpuModelFormatted = cpuModel.replaceAll('_', ' ');
        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        const isAReReg = await hostClient.isTransferee();
        const evrBalance = await hostClient.getEVRBalance();
        if (!isAReReg && hostClient.config.hostRegFee > evrBalance)
            throw `ERROR: EVR balance in the account is less than the registration fee (${hostClient.config.hostRegFee}EVRs).`;
        else if (isAReReg && evrBalance < parseFloat(evernode.EvernodeConstants.NOW_IN_EVRS))
            throw `ERROR: EVR balance in the account is insufficient for re-registration.`;

        // Sometimes we may get 'tecPATH_DRY' error from rippled when some servers in the server cluster
        // haven't still updated the ledger. In such cases, we retry several times before giving up.
        let attempts = 0;
        while (attempts >= 0) {
            try {
                await hostClient.register(countryCode, cpuMicroSec,
                    Math.floor((ramKb + swapKb) / 1000), Math.floor(diskKb / 1000), totalInstanceCount, cpuModelFormatted.substring(0, 40), cpuCount, cpuSpeed, description.replaceAll('_', ' '), emailAddress);

                // Create lease offers.
                console.log("Creating lease offers for instance slots...");
                for (let i = 0; i < totalInstanceCount; i++) {
                    await hostClient.offerLease(i, acc.leaseAmount, appenv.TOS_HASH, config?.networking?.ipv6?.subnet ? UtilHelper.generateIPV6Address(config.networking.ipv6.subnet, i) : null);
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
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        await this.burnMintedURITokens(hostClient.xrplAcc);
        await hostClient.deregister();
        await hostClient.disconnect();
    }

    async regInfo(isBasic) {
        const acc = this.#getConfig(false).xrpl;
        console.log(`Host account address: ${acc.address}`);
        console.log(`Governor address: ${acc?.governorAddress}`);

        if (!isBasic) {
            await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer);

            try {
                const hostClient = new evernode.HostClient(acc.address);
                await hostClient.connect();
                console.log(`Registry address: ${hostClient.config.registryAddress}`);
                console.log(`Heartbeat address: ${hostClient.config.heartbeatAddress}`);

                evernode.Defaults.set({
                    xrplApi: hostClient.xrplApi
                });

                const [evrBalance, hostInfo] = await Promise.all([hostClient.getEVRBalance(), hostClient.getRegistration()]);
                if (hostInfo) {
                    console.log(`Registration URIToken: ${hostInfo.uriTokenId}`);
                }
                else {
                    await hostClient.disconnect();
                    throw 'Host is not registered';
                }
                console.log(`EVR balance: ${evrBalance}`);
                console.log(`Host status: ${hostInfo.active ? 'Active' : 'Inactive'}`);

                await hostClient.disconnect();
            }
            catch {
                throw 'Error occured when retrieving account info.';
            }
        }
    }

    // Upgrades existing message board data to the new version.
    async upgrade(governorAddress) {

        // Do a simple version change in the config.
        const cfg = this.#getConfig();
        cfg.version = appenv.MB_VERSION;

        // Fill missing fields.
        if (!cfg.xrpl.rippledServer)
            cfg.xrpl.rippledServer = appenv.DEFAULT_RIPPLED_SERVER

        if (!cfg.xrpl.governorAddress) {
            await setEvernodeDefaults(cfg.xrpl.network, governorAddress, cfg.xrpl.rippledServer);

            const hostClient = new evernode.HostClient(cfg.xrpl.address, cfg.xrpl.secret);
            await hostClient.connect();

            evernode.Defaults.set({
                xrplApi: hostClient.xrplApi
            });

            cfg.xrpl.governorAddress = governorAddress;

            await hostClient.disconnect();
        }

        this.#saveConfig(cfg);

        await Promise.resolve(); // async placeholder.
    }

    // Get host info.
    async hostInfo() {

        const acc = this.#getConfig(false).xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer);

        const hostClient = new evernode.HostClient(acc.address);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        const hostInfo = await hostClient.getHostInfo();

        await hostClient.disconnect();

        console.log(JSON.stringify(hostInfo, null, 2));
    }

    // Update host info.
    async update(emailAddress) {

        console.log("Updating host...");
        const acc = this.#getConfig().xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        const hostInfo = await hostClient.getHostInfo();
        await hostClient.updateRegInfo(hostInfo.activeInstances, null, null, null, null, null, null, null, null, emailAddress);
        await hostClient.disconnect();
    }

    // Burn the host minted URITokens at the de-registration.
    async burnMintedURITokens(xrplAcc) {
        // Get unsold URITokens.
        const uriTokens = (await xrplAcc.getURITokens()).filter(n => evernode.EvernodeHelpers.isValidURI(n.URI, evernode.EvernodeConstants.LEASE_TOKEN_PREFIX_HEX))
            .map(o => { return { uriTokenId: o.index, ownerAddress: xrplAcc.address }; });

        // Get sold URITokens.
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
                    uriTokens.push(...(await db.getValues(leaseTable)).filter(i => (i.status === "Acquired" || i.status === "Extended"))
                        .map(o => { return { uriTokenId: o.container_name, ownerAddress: o.tenant_xrp_address }; }))
                }
            }
            finally {
                db.close();
            }
        }


        for (const uriToken of uriTokens) {
            const sold = uriToken.ownerAddress !== xrplAcc.address;
            await xrplAcc.burnURIToken(uriToken.uriTokenId);
            console.log(`Burnt ${sold ? 'sold' : 'unsold'} hosting URIToken (${uriToken.uriTokenId}) of ${uriToken.ownerAddress + (sold ? ' tenant' : '')} account`);
        }
    }


    // Initiate Host Machine Transfer.
    async transfer(transfereeAddress) {
        console.log("Transferring host...");
        const acc = this.#getConfig().xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        await hostClient.transfer(transfereeAddress);
        await this.burnMintedURITokens(hostClient.xrplAcc);
        await hostClient.disconnect();
    }

    // Change the message board configurations.
    async changeConfig(leaseAmount, rippledServer, totalInstanceCount, ipv6Subnet, ipv6NetInterface) {

        // Update the configuration.
        const cfg = this.#getConfig();

        if (leaseAmount && isNaN(leaseAmount))
            throw 'Lease amount should be a number';
        else if (rippledServer && !rippledServer.match(/^(wss?:\/\/)([^\/|^:|^ ]{3,})(:([0-9]{1,5}))?$/g))
            throw 'Provided Rippled Server is invalid';
        else if (totalInstanceCount && isNaN(totalInstanceCount))
            throw 'Maximum instance count should be a number';

        const leaseAmountParsed = leaseAmount ? parseInt(leaseAmount) : 0;
        const totalInstanceCountParsed = totalInstanceCount ? parseInt(totalInstanceCount) : 0;

        // Return if not changed.
        if (!totalInstanceCount &&
            (!leaseAmount || cfg.xrpl.leaseAmount == leaseAmount) &&
            (!rippledServer || cfg.xrpl.rippledServer == rippledServer) &&
            (!ipv6Subnet) &&
            (!ipv6NetInterface))
            return;

        await this.recreateLeases(leaseAmountParsed, totalInstanceCountParsed, rippledServer, ipv6Subnet, ipv6NetInterface, cfg);

        if (leaseAmountParsed)
            cfg.xrpl.leaseAmount = leaseAmountParsed;
        if (rippledServer)
            cfg.xrpl.rippledServer = rippledServer;
        this.#saveConfig(cfg);
    }

    // Recreate unsold URITokens
    async recreateLeases(leaseAmount, totalInstanceCount, rippledServer, outboundSubnet, outboundNetInterface, existingCfg) {
        // Get sold URITokens.
        const db = new SqliteDatabase(appenv.DB_PATH);
        const leaseTable = appenv.DB_TABLE_NAME;

        db.open();
        const leaseRecords = (await db.getValues(leaseTable).finally(() => { db.close() })).filter(i => (i.status === "Acquired" || i.status === "Extended"));
        const soldCount = leaseRecords.length;

        if (totalInstanceCount && soldCount > totalInstanceCount)
            throw `There are ${soldCount} active instances, So max instance count cannot be less than that.`;

        const acc = existingCfg.xrpl;
        let xrplApi;
        let hostClient;

        async function initClients(rippledServer) {
            await setEvernodeDefaults(acc.network, acc.governorAddress, rippledServer);
            xrplApi = new evernode.XrplApi();
            hostClient = new evernode.HostClient(acc.address, acc.secret, { xrplApi: xrplApi });
            await xrplApi.connect();
            await hostClient.connect();
            evernode.Defaults.set({
                xrplApi: xrplApi
            });
        }

        async function deinitClients() {
            await hostClient.disconnect();
            await xrplApi.disconnect();
        }

        await initClients(acc.rippledServer);

        // Get unsold URI Tokens.
        const unsoldUriTokens = (await hostClient.xrplAcc.getURITokens()).filter(n => evernode.EvernodeHelpers.isValidURI(n.URI, evernode.EvernodeConstants.LEASE_TOKEN_PREFIX_HEX))
            .map(n => { return { uriTokenId: n.index, leaseIndex: evernode.UtilHelpers.decodeLeaseTokenUri(n.URI).leaseIndex }; });
        const unsoldCount = unsoldUriTokens.length;

        // Return if not changed.
        if (!leaseAmount && !rippledServer && (!totalInstanceCount || (soldCount + unsoldCount) == totalInstanceCount) && (!outboundSubnet || !outboundNetInterface)) {
            await deinitClients();
            return;
        }

        async function getVacantLeaseIndexes(includeUnsold = true) {
            let acquired = includeUnsold ? [] : unsoldUriTokens.map(n => n.leaseIndex);
            let vacant = [];
            for (const l of leaseRecords) {
                try {
                    const tenantAddress = l.tenant_xrp_address;
                    const uriTokenId = l.container_name;
                    const uriToken = (await (new evernode.XrplAccount(tenantAddress, null, { xrplApi: xrplApi })).getURITokens())?.find(n => n.index == uriTokenId);
                    if (uriToken) {
                        const index = evernode.UtilHelpers.decodeLeaseTokenUri(uriToken.URI).leaseIndex;
                        acquired.push(index);
                    }
                } catch {
                }
            }
            let i = 0;
            while (vacant.length + acquired.length < totalInstanceCount) {
                if (!acquired.includes(i))
                    vacant.push(i);
                i++;
            }
            return vacant;
        }

        let uriTokensToBurn = [];
        let uriTokenIndexesToCreate = [];
        // If lease amount is changed we need to burn all the unsold uriTokens
        if ((leaseAmount && acc.leaseAmount !== leaseAmount) || (rippledServer && acc.rippledServer !== rippledServer)) {
            uriTokensToBurn = unsoldUriTokens;

            // If total instance count also changed decide the uriTokens that we need to create.
            if (totalInstanceCount && (soldCount + unsoldCount) !== totalInstanceCount) {
                // If less than current count, Create only first chuck of the burned uriTokens.
                // If greater than current count, create burned uriTokens plus extra uriTokens that are needed.
                if (totalInstanceCount < soldCount + unsoldCount) {
                    uriTokenIndexesToCreate = uriTokensToBurn.map(n => n.leaseIndex).sort((a, b) => a - b).slice(0, totalInstanceCount - soldCount);
                }
                else {
                    uriTokenIndexesToCreate = await getVacantLeaseIndexes();
                }
            }
            else {
                uriTokenIndexesToCreate = uriTokensToBurn.map(n => n.leaseIndex);
            }
        }
        // If only instance count is changed decide whether we need to add or burn comparing the current count and updated count.
        else if (totalInstanceCount && (soldCount + unsoldCount) !== totalInstanceCount) {
            if (totalInstanceCount < soldCount + unsoldCount) {
                uriTokensToBurn = unsoldUriTokens.sort((a, b) => a.leaseIndex - b.leaseIndex).slice(totalInstanceCount - soldCount);
                uriTokenIndexesToCreate = [];
            }
            else {
                uriTokensToBurn = [];
                uriTokenIndexesToCreate = await getVacantLeaseIndexes(false);
            }
        }
        // If only instance outbound networking was changed.
        else if (outboundSubnet && outboundNetInterface) {
            uriTokensToBurn = unsoldUriTokens;
            uriTokenIndexesToCreate = uriTokensToBurn.map(n => n.leaseIndex);

            // Updating the config object fields.
            existingCfg.networking = { ipv6: { subnet: outboundSubnet, interface: outboundNetInterface } }
        }

        for (const uriToken of uriTokensToBurn) {
            try {
                await hostClient.expireLease(uriToken.uriTokenId);
            }
            catch (e) {
                console.error(e);
            }
        }

        // If rippled server is changed, create new uriTokens from new server.
        if (rippledServer && rippledServer !== acc.rippledServer) {
            await initClients(rippledServer);
        }

        for (const idx of uriTokenIndexesToCreate) {
            try {
                await hostClient.offerLease(idx,
                    leaseAmount ? leaseAmount : acc.leaseAmount,
                    appenv.TOS_HASH,
                    (existingCfg?.networking?.ipv6?.subnet) ? UtilHelper.generateIPV6Address(existingCfg.networking.ipv6.subnet, idx) : null);
            }
            catch (e) {
                console.error(e);
            }
        }

        await deinitClients();
    }

    async deleteInstance(containerName) {
        const sashiCliPath = appenv.SASHI_CLI_PATH;
        if (!fs.existsSync(sashiCliPath))
            throw `Sashi CLI does not exist in ${sashiCliPath}.`;

        let db;
        let xrplApi;
        let hostClient;
        try {
            console.log(`Destroying the instance...`);

            // Destroy the instance.
            const sashiCli = new SashiCLI(sashiCliPath);
            await sashiCli.destroyInstance(containerName);

            db = new SqliteDatabase(appenv.DB_PATH);
            db.open();
            const leaseTable = appenv.DB_TABLE_NAME;

            let lease = await db.getValues(leaseTable, { container_name: containerName });

            if (lease.length > 0) {
                lease = lease[0];

                const acc = this.#getConfig().xrpl;
                await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer);

                xrplApi = new evernode.XrplApi(acc.rippledServer);
                await xrplApi.connect();

                evernode.Defaults.set({
                    xrplApi: xrplApi
                });

                // Get the existing uriToken of the lease.
                const uriToken = (await (new evernode.XrplAccount(lease.tenant_xrp_address, null, { xrplApi: xrplApi }).getURITokens()))?.find(n => n.index == lease.container_name);

                if (uriToken) {
                    hostClient = new evernode.HostClient(acc.address, acc.secret, { xrplApi: xrplApi });
                    await hostClient.connect();

                    // Delete instance from sashiDB and burn the token
                    const uriInfo = evernode.UtilHelpers.decodeLeaseTokenUri(uriToken.URI);

                    console.log(`Expiring the lease...`);

                    // Burn the URITokens and recreate the offer.
                    await hostClient.expireLease(containerName, lease.tenant_xrp_address).catch(console.error);

                    await hostClient.offerLease(uriInfo.leaseIndex, acc.leaseAmount, appenv.TOS_HASH, uriInfo?.outboundIP?.address).catch(console.error);

                    // Refund EVRs to the tenant.
                    const currentTime = evernode.UtilHelpers.getCurrentUnixTime();
                    const spentMoments = Math.ceil((currentTime - lease.timestamp) / hostClient.config.momentSize);
                    const remainingMoments = lease.life_moments - spentMoments;
                    if (remainingMoments > 0) {
                        console.log(`Refunding tenant ${lease.tenant_xrp_address}...`);
                        await hostClient.refundTenant(lease.tx_hash, lease.tenant_xrp_address, (uriInfo.leaseAmount * remainingMoments).toString());
                    }
                }

                // Delete the lease record related to this instance (Permanent Delete).
                await db.deleteValues(leaseTable, { tx_hash: lease.tx_hash });
            }

            console.log(`Destroyed instance ${lease.container_name}`);
        }
        catch (e) { throw e }
        finally {
            if (db)
                db.close();
            if (hostClient)
                await hostClient.disconnect();
            if (xrplApi)
                await xrplApi.disconnect();
        }
    }

    async setRegularKey(regularKey) {
        {
            const acc = this.#getConfig().xrpl;
            await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer);

            console.log(`Setting Regular Key...`);

            try {
                await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer);

                const xrplApi = new evernode.XrplApi(acc.rippledServer, { autoReconnect: false });
                await xrplApi.connect();

                const xrplAcc = new evernode.XrplAccount(acc.address, acc.secret, { xrplApi: xrplApi });

                await xrplAcc.setRegularKey(regularKey);
                console.log(`Regular key ${regularKey} was assigned to account ${acc.address} successfully.`);

                await xrplApi.disconnect();
            }
            catch (e) {
                throw e;
            }
        }
    }
}

module.exports = {
    Setup
}