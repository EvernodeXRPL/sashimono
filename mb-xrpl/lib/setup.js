
const { appenv } = require('./appenv');
const evernode = require('evernode-js-client');
const fs = require('fs');
const { SqliteDatabase } = require('./sqlite-handler');
const { ConfigHelper } = require('./config-helper');
const { SashiCLI } = require('./sashi-cli');
const { UtilHelper } = require('./util-helper');

async function setEvernodeDefaults(network, governorAddress, rippledServer, fallbackRippledServers) {
    await evernode.Defaults.useNetwork(network || appenv.NETWORK);

    if (governorAddress)
        evernode.Defaults.set({
            governorAddress: governorAddress
        });

    if (rippledServer)
        evernode.Defaults.set({
            rippledServer: rippledServer
        });

    if (fallbackRippledServers && fallbackRippledServers.length)
        evernode.Defaults.set({
            fallbackRippledServers: fallbackRippledServers
        });
}

const MAX_TX_RETRY_ATTEMPTS = 10;

class Setup {

    #getConfig(readSecret = true) {
        return ConfigHelper.readConfig(appenv.CONFIG_PATH, appenv.REPUTATIOND_CONFIG_PATH, readSecret);
    }

    #saveConfig(cfg) {
        ConfigHelper.writeConfig(cfg, appenv.CONFIG_PATH);
    }

    newConfig(address = "", secretPath = "", governorAddress = "", leaseAmount = 0, rippledServer = null, ipv6Subnet = null, ipv6NetInterface = null, network = "", affordableExtraFee = 0, emailAddress = null, fallbackRippledServers = null) {
        const baseConfig = {
            version: appenv.MB_VERSION,
            xrpl: {
                network: network,
                address: address,
                secretPath: secretPath,
                governorAddress: governorAddress,
                rippledServer: rippledServer || appenv.DEFAULT_RIPPLED_SERVER,
                leaseAmount: leaseAmount,
                affordableExtraFee: affordableExtraFee,
                fallbackRippledServers: fallbackRippledServers ?? []
            },
            host: {
                emailAddress: emailAddress
            }
        };

        this.#saveConfig(ipv6NetInterface ? { ...baseConfig, networking: { ipv6: { subnet: ipv6Subnet, interface: ipv6NetInterface } } } : baseConfig);
    }

    async prepareHostAccount(domain) {

        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        // Prepare host account.
        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        try {
            console.log(`Preparing host account:${acc.address} (domain:${domain} registry:${hostClient.config.registryAddress})`);
            await hostClient.prepareAccount(domain, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
            await hostClient.disconnect();
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }
    }

    async waitForFunds(currencyType, expectedBalance, waitPeriod = 120) {

        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        // Prepare host account.
        const hostClient = new evernode.HostClient(acc.address, acc.secret);

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        try {
            let attempts = 0;
            let balance = 0;
            while (attempts >= 0) {
                try {
                    // In order to handle the account not found issue via catch block.
                    await hostClient.connect();

                    await new Promise(resolve => setTimeout(resolve, 1000));
                    if (currencyType === 'NATIVE')
                        balance = Number((await hostClient.xrplAcc.getInfo()).Balance) / 1000000;
                    else
                        balance = Number(await hostClient.getEVRBalance());

                    if (balance < expectedBalance) {
                        if (++attempts <= waitPeriod)
                            continue;

                        await hostClient.disconnect();
                        throw "NOT_ENOUGH_FUNDS";
                    }

                    break;
                } catch (err) {
                    if (err.data?.error === 'actNotFound' && ++attempts <= waitPeriod) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }
                    await hostClient.disconnect();
                    throw (err.data?.error === 'actNotFound' || err === 'NOT_ENOUGH_FUNDS') ? "Funds not received within timeout." : "Error occurred in account balance check.";
                }
            }

            console.log(`${balance} ${currencyType == 'NATIVE' ? 'XAH' : 'EVR'} balance is there in your host account.`);
            await hostClient.disconnect();
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }
    }

    async checkRegistration(countryCode = null, cpuMicroSec = null, ramKb = null, swapKb = null, diskKb = null, totalInstanceCount = null, cpuModel = null, cpuCount = null, cpuSpeed = null, emailAddress = null, description = null) {
        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        await hostClient.xrplApi.connect();
        if (!await hostClient.xrplAcc.exists()) {
            throw "CLI_OUT: ACC_NOT_FOUND";
        }

        await hostClient.connect();

        try {
            const regInfo = await hostClient.getHostInfo();
            // Check whether pending transfer exists.
            const transferPending = await hostClient.isTransferee();

            if (!transferPending && regInfo && countryCode != null) {
                // Check wether the registration params are matching with existing.
                const cpuModelFormatted = cpuModel.replaceAll('_', ' ').substring(0, 40);
                const descriptionFormatted = description.replaceAll('_', ' ');
                const emailFormatted = emailAddress.substring(0, 40);
                const ramMb = Math.floor((ramKb + swapKb) / 1000);
                const diskMb = Math.floor(diskKb / 1000);
                if (!(regInfo.countryCode === countryCode &&
                    regInfo.maxInstances === totalInstanceCount &&
                    regInfo.cpuModelName === cpuModelFormatted &&
                    regInfo.cpuMHz === cpuSpeed &&
                    regInfo.cpuCount === cpuCount &&
                    regInfo.cpuMicrosec === cpuMicroSec &&
                    regInfo.email === emailFormatted &&
                    regInfo.description === descriptionFormatted &&
                    regInfo.ramMb === ramMb &&
                    regInfo.diskMb === diskMb)) {
                    throw "CLI_OUT: INVALID_REG";
                }
            }

            // Check whether host has a registration token.
            const regUriToken = await hostClient.getRegistrationUriToken();
            if (regUriToken) {
                const registered = await hostClient.isRegistered();
                if (registered) {
                    console.log("CLI_OUT: REGISTERED");
                    await hostClient.disconnect();
                    return true;
                }
                else {
                    throw "CLI_OUT: INVALID_REG";
                }
            }
            else if (regInfo) {
                const registryAcc = new evernode.XrplAccount(hostClient.config.registryAddress);
                const sellOffer = (await registryAcc.getURITokens()).find(o => o.Issuer == registryAcc.address && o.index == regInfo.uriTokenId && o.Amount);
                if (sellOffer)
                    throw "CLI_OUT: PENDING_SELL_OFFER";
            }
            else if (transferPending)
                throw "CLI_OUT: PENDING_TRANSFER";

            throw "CLI_OUT: NOT_REGISTERED"
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }
    }

    async checkBalance() {
        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        try {
            const isAReReg = await hostClient.isTransferee();
            const evrBalance = await hostClient.getEVRBalance();
            if (!isAReReg && hostClient.config.hostRegFee > evrBalance)
                throw `EVR balance in the account is less than the registration fee (${hostClient.config.hostRegFee}EVRs).`;
            else if (isAReReg && evrBalance < parseFloat(evernode.EvernodeConstants.NOW_IN_EVRS))
                throw `EVR balance in the account is insufficient for re-registration.`;
            await hostClient.disconnect();
            return true;
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }
    }

    async acceptRegToken() {
        console.log("Accepting registration token...");
        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        try {
            var res = await hostClient.acceptRegToken({ retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
            await hostClient.disconnect();
            return res;
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }
    }

    async register(countryCode, cpuMicroSec, ramKb, swapKb, diskKb, totalInstanceCount, cpuModel, cpuCount, cpuSpeed, emailAddress, description) {
        console.log("Registering host...");
        let cpuModelFormatted = cpuModel.replaceAll('_', ' ');
        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        try {
            await hostClient.register(countryCode, cpuMicroSec,
                Math.floor((ramKb + swapKb) / 1000), Math.floor(diskKb / 1000), totalInstanceCount, cpuModelFormatted.substring(0, 40), cpuCount, cpuSpeed, description.replaceAll('_', ' '), emailAddress, acc?.leaseAmount, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });

            await hostClient.disconnect();
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }
    }

    async mintLeases(totalInstanceCount) {
        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        try {
            const leases = await hostClient.getLeases();

            // Terminate if existing leases are inconsistent with current.
            let lastIndex = 0;
            if (leases.length) {
                for (const l of leases) {
                    if (l.Amount && l.Amount.value !== acc.leaseAmount) {
                        console.error('Lease amount is inconsistent with existing.');
                        throw 'CLI_OUT: LEASE_AMT_ERR';
                    }
                    const tokenInfo = evernode.UtilHelpers.decodeLeaseTokenUri(l.URI);
                    if (tokenInfo.leaseAmount !== acc.leaseAmount) {
                        console.error('Lease amount is inconsistent with existing.');
                        throw 'CLI_OUT: LEASE_AMT_ERR';
                    }
                    const leaseIndex = tokenInfo.leaseIndex;
                    const outboundIP = tokenInfo.outboundIP;

                    if ((outboundIP && !config?.networking?.ipv6?.subnet) || (!outboundIP && config?.networking?.ipv6?.subnet)) {
                        console.error('Outbound IP is inconsistent with existing.');
                        throw 'CLI_OUT: LEASE_IP_ERR';
                    }
                    else if (outboundIP && config?.networking?.ipv6?.subnet) {
                        if (!UtilHelper.isInIPV6Subnet(config?.networking?.ipv6?.subnet, outboundIP.address)) {
                            console.error('Outbound IP is inconsistent with existing.');
                            throw 'CLI_OUT: LEASE_IP_ERR';
                        }
                    }

                    if (leaseIndex > lastIndex) {
                        lastIndex = leaseIndex;
                    }
                }
            }

            if (totalInstanceCount >= leases.length) {
                // Create leases.
                console.log("Minting leases for instance slots...");
                for (let i = (leases.length > 0 ? (lastIndex + 1) : 0); i < totalInstanceCount; i++) {
                    await hostClient.mintLease(i, acc.leaseAmount, appenv.TOS_HASH, config?.networking?.ipv6?.subnet ? UtilHelper.generateIPV6Address(config.networking.ipv6.subnet, i) : null, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
                    console.log(`Minted lease ${i + 1} of ${totalInstanceCount}.`);
                }
            }
            else {
                // Burn leases.
                console.log("Burning previous leases...");
                for (let i = totalInstanceCount; i < leases.length; i++) {
                    await hostClient.expireLease(leases[i].index, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
                    console.log(`Burned lease ${i + 1} of ${leases.length}.`);
                }
            }
            await hostClient.disconnect();
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }
    }

    async offerLeases() {
        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        try {
            const unoffered = await hostClient.getUnofferedLeases();

            if (unoffered.length > 0) {
                // Create lease offers.
                console.log("Creating lease offers for instance slots...");
                let i = 0;
                for (let t of unoffered) {
                    const uriInfo = evernode.UtilHelpers.decodeLeaseTokenUri(t.URI);
                    if (uriInfo.leaseAmount == acc.leaseAmount) {
                        await hostClient.offerMintedLease(t.index, acc.leaseAmount, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
                        console.log(`Created lease offer ${i + 1} of ${unoffered.length}.`);
                    }
                    else {
                        console.error('Lease amounts are inconsistent.');
                        throw 'CLI_OUT: LEASE_AMT_ERR';
                    }
                    i++;
                }
            }
            else {
                console.error('No unoffered leases.');
                throw 'CLI_OUT: LEASE_OFFER_ERR';
            }

            await hostClient.disconnect();
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }

    }

    async burnLeases() {
        const config = this.#getConfig();
        const acc = config.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        try {
            await this.burnMintedURITokens(hostClient, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
            await hostClient.disconnect();
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }
    }

    async deregister(error = null) {
        console.log("Deregistering host...");
        const acc = this.#getConfig().xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        try {
            await hostClient.deregister(error, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
            await hostClient.disconnect();
        }
        catch (e) {
            await hostClient.disconnect();
            throw e;
        }
    }

    async regInfo(isBasic) {
        const cfg = this.#getConfig(false);
        const acc = cfg.xrpl;
        console.log(`Version: ${cfg.version}`);
        console.log(`Host account address: ${acc.address}`);
        console.log(`Governor address: ${acc?.governorAddress}`);

        if (!isBasic) {
            await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

            try {
                const hostClient = new evernode.HostClient(acc.address);
                await hostClient.connect();
                console.log(`Registry address: ${hostClient.config.registryAddress}`);
                console.log(`Heartbeat address: ${hostClient.config.heartbeatAddress}`);

                evernode.Defaults.set({
                    xrplApi: hostClient.xrplApi
                });

                const [evrBalance, hostInfo, totalLeases, offeredLeases, unofferedLeases] = await Promise.all(
                    [
                        hostClient.getEVRBalance(),
                        hostClient.getRegistration(),
                        hostClient.getLeases(),
                        hostClient.getLeaseOffers(),
                        hostClient.getUnofferedLeases()
                    ]);

                if (hostInfo) {
                    console.log(`Registration URIToken: ${hostInfo.uriTokenId}`);
                }
                else {
                    await hostClient.disconnect();
                    throw 'Host is not registered';
                }
                console.log(`EVR balance: ${evrBalance}`);
                if (hostInfo.maxInstances > 0) {
                    console.log(`Available Lease offers: ${offeredLeases.length} out of ${hostInfo.maxInstances}`);
                    if (unofferedLeases.length > 0) {
                        console.log(`Lease offers to be created: ${unofferedLeases.length} out of ${totalLeases.length}`);
                        console.log('NOTE: Please use `evernode offerlease` command to create offers for the minted lease tokens.');
                        console.log('The host becomes eligible to send heartbeats after generating offers for minted lease tokens.');
                    }
                }
                console.log(`\nHost status: ${hostInfo.active ? 'active' : 'inactive'}`);
                console.log(`\nCountry code: ${hostInfo.countryCode}`);

                await hostClient.disconnect();
            }
            catch (e) {
                throw 'Error occurred when retrieving account info.';
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

    // Get host info.
    async hostInfo() {

        const acc = this.#getConfig(false).xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

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
        const cfg = this.#getConfig();
        const acc = cfg.xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        // Update the Defaults with "xrplApi" of the client.
        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        const hostInfo = await hostClient.getHostInfo();
        const availableLeaseOffers = await hostClient.getLeaseOffers();
        if (availableLeaseOffers.length > 0 && Number(availableLeaseOffers[0].Amount?.value) !== acc.leaseAmount) {
            acc.leaseAmount = parseFloat(availableLeaseOffers[0].Amount?.value);
        }

        await hostClient.updateRegInfo(hostInfo.activeInstances, null, null, null, null, null, null, null, null, emailAddress, acc?.leaseAmount, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
        await hostClient.disconnect();

        if (emailAddress) {
            cfg.host.emailAddress = emailAddress
            this.#saveConfig(cfg);
        }
    }

    // Burn the host minted URITokens at the de-registration.
    async burnMintedURITokens(hostClient, options = {}) {
        // Get unsold URITokens.
        const uriTokens = (await hostClient.xrplAcc.getURITokens()).filter(n => n.Issuer == hostClient.xrplAcc.address && evernode.EvernodeHelpers.isValidURI(n.URI, evernode.EvernodeConstants.LEASE_TOKEN_PREFIX_HEX))
            .map(o => { return { uriTokenId: o.index, ownerAddress: hostClient.xrplAcc.address }; });

        // Get sold URITokens.
        // We check for db existence since db is created by message board (not setup).
        const dbPath = appenv.DB_PATH;
        if (fs.existsSync(dbPath)) {
            // This local initialization can be changed according to the DB access requirement.
            const db = new SqliteDatabase(appenv.DB_PATH);
            const leaseTable = appenv.DB_TABLE_NAME;

            db.open();

            try {
                // We check for table existence since table is created by message board (not setup).
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
            const sold = uriToken.ownerAddress !== hostClient.xrplAcc.address;
            await hostClient.expireLease(uriToken.uriTokenId, options);
            console.log(`Burnt ${sold ? 'sold' : 'unsold'} hosting URIToken (${uriToken.uriTokenId}) of ${uriToken.ownerAddress + (sold ? ' tenant' : '')} account`);
        }
    }


    // Initiate Host Machine Transfer.
    async transfer(transfereeAddress) {
        console.log("Transferring host...");
        const acc = this.#getConfig().xrpl;
        await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);
        await hostClient.connect();

        evernode.Defaults.set({
            xrplApi: hostClient.xrplApi
        });

        await hostClient.transfer(transfereeAddress, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
        await this.burnMintedURITokens(hostClient, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
        await hostClient.disconnect();
    }

    // Change the message board configurations.
    async changeConfig(leaseAmount, rippledServer, totalInstanceCount, ipv6Subnet, ipv6NetInterface, affordableExtraFee, fallbackRippledServers) {

        // Update the configuration.
        const cfg = this.#getConfig();

        if (leaseAmount && isNaN(leaseAmount))
            throw 'Lease amount should be a number';
        else if (rippledServer && !rippledServer.match(/^(wss?:\/\/)([^\/|^ ]{3,})(:([0-9]{1,5}))?$/g))
            throw 'Provided Xahaud Server is invalid';
        else if (totalInstanceCount && isNaN(totalInstanceCount))
            throw 'Maximum instance count should be a number';
        else if (affordableExtraFee && isNaN(affordableExtraFee))
            throw 'Affordable txn fee should be a number';

        if (fallbackRippledServers) {
            for (const url of fallbackRippledServers) {
                if (!url.match(/^(wss?:\/\/)([^\/|^:|^ ]{3,})(:([0-9]{1,5}))?$/g))
                    throw 'Provided fallback Xahaud Server is invalid';
            }
        }

        const leaseAmountParsed = leaseAmount ? parseFloat(leaseAmount) : 0;
        const totalInstanceCountParsed = totalInstanceCount ? parseInt(totalInstanceCount) : 0;
        const affordableExtraFeeParsed = affordableExtraFee ? parseInt(affordableExtraFee) : 0;


        // Return if not changed.
        if (!totalInstanceCount &&
            (!leaseAmount || cfg.xrpl.leaseAmount == leaseAmount) &&
            (!rippledServer || cfg.xrpl.rippledServer == rippledServer) &&
            (!ipv6Subnet) &&
            (!ipv6NetInterface) &&
            (affordableExtraFee == null || cfg.xrpl.affordableExtraFee == affordableExtraFee))
            return;

        await this.recreateLeases(leaseAmountParsed, totalInstanceCountParsed, rippledServer, ipv6Subnet, ipv6NetInterface, cfg);

        if (leaseAmountParsed)
            cfg.xrpl.leaseAmount = leaseAmountParsed;
        if (rippledServer)
            cfg.xrpl.rippledServer = rippledServer;
        if (affordableExtraFee != null)
            cfg.xrpl.affordableExtraFee = affordableExtraFeeParsed;
        if (fallbackRippledServers)
            cfg.xrpl.fallbackRippledServers = fallbackRippledServers;

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
            await setEvernodeDefaults(acc.network, acc.governorAddress, rippledServer, acc.fallbackRippledServers);
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
        const unsoldUriTokens = (await hostClient.xrplAcc.getURITokens()).filter(n => n.Issuer == hostClient.xrplAcc.address && evernode.EvernodeHelpers.isValidURI(n.URI, evernode.EvernodeConstants.LEASE_TOKEN_PREFIX_HEX))
            .map(n => { return { uriTokenId: n.index, leaseIndex: evernode.UtilHelpers.decodeLeaseTokenUri(n.URI).leaseIndex }; });
        const unsoldCount = unsoldUriTokens.length;

        // Return if not changed.
        if (!leaseAmount && (!totalInstanceCount || (soldCount + unsoldCount) == totalInstanceCount) && (!outboundSubnet || !outboundNetInterface)) {
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
        if (leaseAmount && acc.leaseAmount !== leaseAmount) {
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
                await hostClient.expireLease(uriToken.uriTokenId, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
            }
            catch (e) {
                console.error(e);
            }
        }

        // If rippled server is changed, create new uriTokens from new server.
        if (rippledServer && rippledServer !== acc.rippledServer) {
            // Deinit previous connections
            await deinitClients();
            await initClients(rippledServer);
        }

        for (const idx of uriTokenIndexesToCreate) {
            try {
                await hostClient.offerLease(idx,
                    leaseAmount ? leaseAmount : acc.leaseAmount,
                    appenv.TOS_HASH,
                    (existingCfg?.networking?.ipv6?.subnet) ? UtilHelper.generateIPV6Address(existingCfg.networking.ipv6.subnet, idx) : null, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
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
            const sashiCli = new SashiCLI(sashiCliPath, appenv.IS_DEV_MODE ? { DATA_DIR: path.join(appenv.DATA_DIR, '../') } : {});
            await sashiCli.destroyInstance(containerName);

            db = new SqliteDatabase(appenv.DB_PATH);
            db.open();
            const leaseTable = appenv.DB_TABLE_NAME;

            let lease = await db.getValues(leaseTable, { container_name: containerName });

            if (lease.length > 0) {
                lease = lease[0];

                const acc = this.#getConfig().xrpl;
                await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

                xrplApi = new evernode.XrplApi();
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
                    await hostClient.expireLease(containerName, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } }).catch(console.error);

                    await hostClient.offerLease(uriInfo.leaseIndex, acc.leaseAmount, appenv.TOS_HASH, uriInfo?.outboundIP?.address, { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } }).catch(console.error);

                    // Refund EVRs to the tenant.
                    const currentTime = evernode.UtilHelpers.getCurrentUnixTime();
                    const spentMoments = Math.ceil((currentTime - lease.timestamp) / hostClient.config.momentSize);
                    const remainingMoments = lease.life_moments - spentMoments;
                    if (remainingMoments > 0) {
                        console.log(`Refunding tenant ${lease.tenant_xrp_address}...`);
                        await hostClient.refundTenant(lease.tx_hash, lease.tenant_xrp_address, (uriInfo.leaseAmount * remainingMoments).toString(), { retryOptions: { maxRetryAttempts: MAX_TX_RETRY_ATTEMPTS, feeUplift: Math.floor(acc.affordableExtraFee / MAX_TX_RETRY_ATTEMPTS) } });
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
            await setEvernodeDefaults(acc.network, acc.governorAddress, acc.rippledServer, acc.fallbackRippledServers);

            if (regularKey) {
                console.log(`Setting Regular Key...`);
            }
            else {
                console.log(`Deleting Regular Key...`);
            }

            try {
                const xrplApi = new evernode.XrplApi(null, { autoReconnect: false });
                await xrplApi.connect();

                evernode.Defaults.set({
                    xrplApi: xrplApi
                });

                const xrplAcc = new evernode.XrplAccount(acc.address, acc.secret);

                await xrplAcc.setRegularKey(regularKey);

                if (regularKey) {
                    console.log(`Regular key ${regularKey} was assigned to account ${acc.address} successfully.`);
                }
                else {
                    console.log(`Regular key was deleted from account ${acc.address} successfully.`);
                }

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