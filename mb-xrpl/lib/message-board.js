const fs = require('fs');
const evernode = require('evernode-js-client');
const { SqliteDatabase, DataTypes } = require('./sqlite-handler');
const { appenv } = require('./appenv');
const { SashiCLI } = require('./sashi-cli');
const { ConfigHelper } = require('./config-helper');

const LeaseStatus = {
    ACQUIRING: 'Acquiring',
    ACQUIRED: 'Acquired',
    FAILED: 'Failed',
    EXPIRED: 'Expired',
    SASHI_TIMEOUT: 'SashiTimeout',
    EXTENDED: 'Extended'
}

class MessageBoard {
    constructor(configPath, secretConfigPath, dbPath, sashiCliPath) {
        this.configPath = configPath;
        this.secretConfigPath = secretConfigPath;
        this.leaseTable = appenv.DB_TABLE_NAME;
        this.utilTable = appenv.DB_UTIL_TABLE_NAME;
        this.expiryList = [];
        this.activeInstanceCount = 0;

        if (!fs.existsSync(sashiCliPath))
            throw `Sashi CLI does not exist in ${sashiCliPath}.`;

        this.sashiCli = new SashiCLI(sashiCliPath);
        this.db = new SqliteDatabase(dbPath);
    }

    async init() {
        this.readConfig();
        if (!this.cfg.version || !this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.registryAddress)
            throw "Required cfg fields cannot be empty.";

        console.log("Using registry " + this.cfg.xrpl.registryAddress);

        this.xrplApi = new evernode.XrplApi();
        evernode.Defaults.set({
            registryAddress: this.cfg.xrpl.registryAddress,
            xrplApi: this.xrplApi
        })
        await this.xrplApi.connect();

        this.hostClient = new evernode.HostClient(this.cfg.xrpl.address, this.cfg.xrpl.secret);
        await this.#connectHost();
        // Get last heartbeat moment from the host info.
        const hostInfo = await this.hostClient.getRegistration();
        if (!hostInfo)
            throw "Host is not registered.";

        // Get moment only if heartbeat info is not 0.
        this.lastHeartbeatMoment = hostInfo.lastHeartbeatLedger ? await this.hostClient.getMoment(hostInfo.lastHeartbeatLedger) : 0;

        this.db.open();
        // Create lease table if not exist.
        await this.createLeaseTableIfNotExists();
        await this.createUtilDataTableIfNotExists();

        this.lastValidatedLedgerIndex = this.xrplApi.ledgerIndex;

        const leaseRecords = (await this.getLeaseRecords()).filter(r => (r.status === LeaseStatus.ACQUIRED || r.status === LeaseStatus.EXTENDED));
        for (const lease of leaseRecords)
            this.addToExpiryList(lease.tx_hash, lease.container_name, lease.tenant_xrp_address, this.getExpiryLedger(lease.created_on_ledger, lease.life_moments));

        this.activeInstanceCount = leaseRecords.length;
        console.log(`Active instance count: ${this.activeInstanceCount}`);
        // Update the registry with the active instance count.
        await this.hostClient.updateRegInfo(this.activeInstanceCount, this.cfg.version);
        this.db.close();

        // Check for instance expiry.
        this.xrplApi.on(evernode.XrplApiEvents.LEDGER, async (e) => {
            this.lastValidatedLedgerIndex = e.ledger_index;

            const currentMoment = await this.hostClient.getMoment(e.ledger_index);

            // Sending heartbeat every CONF_HOST_HEARTBEAT_FREQ moments.
            if (this.lastHeartbeatMoment === 0 || (currentMoment % this.hostClient.config.hostHeartbeatFreq === 0 && currentMoment !== this.lastHeartbeatMoment)) {
                this.lastHeartbeatMoment = currentMoment;

                console.log(`Reporting heartbeat at Moment ${this.lastHeartbeatMoment}...`)

                try {
                    await this.hostClient.heartbeat();
                }
                catch (err) {
                    if (err.code === 'tecHOOK_REJECTED')
                        console.log("Heartbeat rejected by the hook.");
                    else
                        console.log("Heartbeat tx error", err);
                }
            }

            // Filter out instances which needed to be expired and destroy them.
            const expired = this.expiryList.filter(x => x.expiryLedger < e.ledger_index);
            if (expired && expired.length) {
                this.expiryList = this.expiryList.filter(x => x.expiryLedger >= e.ledger_index);

                this.db.open();
                for (const x of expired) {
                    try {
                        console.log(`Moments exceeded (current ledger:${e.ledger_index}, expiry ledger:${x.expiryLedger}). Destroying ${x.containerName}`);
                        // Expire the current lease agreement (Burn the instance NFT) and re-minting and creating sell offer for the same lease index.
                        const nft = (await (new evernode.XrplAccount(x.tenant)).getNfts())?.find(n => n.NFTokenID == x.containerName);
                        if (!nft)
                            throw `Cannot find a NFT for ${x.containerName}`;

                        const uriInfo = evernode.UtilHelpers.decodeLeaseNftUri(nft.URI);
                        await this.destroyInstance(x.containerName, x.tenant, uriInfo.leaseIndex, true);
                        this.activeInstanceCount--;
                        await this.hostClient.updateRegInfo(this.activeInstanceCount);

                        /**
                         * Soft deletion for debugging purpose.
                         */
                        // await this.updateLeaseStatus(x.txHash, LeaseStatus.EXPIRED);

                        // Delete the lease record related to this instance (Permanent Delete).
                        await this.deleteLeaseRecord(x.txHash);
                        console.log(`Destroyed ${x.containerName}`);
                    }
                    catch (e) {
                        console.error(e);
                    }
                }
                this.db.close();
            }
        });

        this.hostClient.on(evernode.HostEvents.AcquireLease, r => this.handleAcquireLease(r));
        this.hostClient.on(evernode.HostEvents.ExtendLease, r => this.handleExtendLease(r));
    }

    // Connect the host and trying to reconnect in the event of account not found error.
    // Account not found error can be because of a network reset. (Dev and test nets)
    async #connectHost() {
        let attempts = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                attempts++;
                const ret = await this.hostClient.connect();
                if (ret)
                    break;
            } catch (error) {
                if (error?.data?.error === 'actNotFound') {
                    let delaySec;
                    // The maximum delay will be 5 minutes.
                    if (attempts > 150) {
                        delaySec = 300;
                    } else {
                        delaySec = 2 * attempts;
                    }
                    console.log(`Network reset detected. Attempt ${attempts} failed. Retrying in ${delaySec}s...`);
                    await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
                } else
                    throw error;
            }
        }
    }

    async recreateLeaseOffer(nfTokenId, tenantAddress, leaseIndex) {
        // Burn the NFTs and recreate the offer and send back the lease amount back to the tenant.
        await this.hostClient.expireLease(nfTokenId, tenantAddress).catch(console.error);
        // We refresh the config here, So if the purchaserTargetPrice is updated by the purchaser service, the new value will be taken.
        this.hostClient.refreshConfig();
        const leaseAmount = this.cfg.xrpl.leaseAmount ? this.cfg.xrpl.leaseAmount : parseFloat(this.hostClient.config.purchaserTargetPrice);
        await this.hostClient.offerLease(leaseIndex, leaseAmount, appenv.TOS_HASH).catch(console.error);
    }

    async handleAcquireLease(r) {

        const acquireRefId = r.acquireRefId; // Acquire tx hash.
        const nfTokenId = r.nfTokenId;
        const leaseAmount = parseFloat(r.leaseAmount);
        const tenantAddress = r.tenant;
        let requestValidated = false;
        let createRes;
        let leaseIndex = -1; // Lease index cannot be negative, So we keep initial non populated value as -1.

        this.db.open();

        try {

            if (r.host !== this.cfg.xrpl.address)
                throw "Invalid host in the lease aquire.";

            // Update last watched ledger sequence number.
            await this.updateLastIndexRecord(r.transaction.LastLedgerSequence);

            // Get the existing nft of the lease.
            const nft = (await (new evernode.XrplAccount(tenantAddress)).getNfts())?.find(n => n.NFTokenID == nfTokenId);
            if (!nft)
                throw 'Could not find the nft for lease acquire request.';

            const uriInfo = evernode.UtilHelpers.decodeLeaseNftUri(nft.URI);

            if (leaseAmount != uriInfo.leaseAmount)
                throw 'NFT embedded lease amount and acquire lease amount does not match.';
            leaseIndex = uriInfo.leaseIndex;

            // Since acquire is accepted for leaseAmount
            const moments = 1;

            // Use NFTokenId as the instance name.
            const containerName = nfTokenId;
            console.log(`Received acquire lease from ${tenantAddress}`);
            requestValidated = true;
            await this.createLeaseRecord(acquireRefId, tenantAddress, containerName, moments);

            // The last validated ledger when we receive the acquire request.
            const startingValidatedLedger = this.lastValidatedLedgerIndex;

            // Wait until the sashi cli is available.
            await this.sashiCli.wait();

            // Number of validated ledgers passed while processing the last request.
            let diff = this.lastValidatedLedgerIndex - startingValidatedLedger;
            // Give-up the acquiring process if processing the last request takes more than 40% of allowed window.
            let threshold = this.hostClient.config.leaseAcquireWindow * appenv.ACQUIRE_LEASE_WAIT_TIMEOUT_THRESHOLD;
            if (diff > threshold) {
                console.error(`Sashimono busy timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                // Update the lease status of the request to 'SashiTimeout'.
                await this.updateAcquireStatus(acquireRefId, LeaseStatus.SASHI_TIMEOUT);
                await this.recreateLeaseOffer(nfTokenId, tenantAddress, leaseIndex);
            }
            else {
                const instanceRequirements = r.payload;
                createRes = await this.sashiCli.createInstance(containerName, instanceRequirements);

                // Number of validated ledgers passed while the instance is created.
                diff = this.lastValidatedLedgerIndex - startingValidatedLedger;
                // Give-up the acquiringing porocess if the instance creation itself takes more than 80% of allowed window.
                threshold = this.hostClient.config.leaseAcquireWindow * appenv.ACQUIRE_LEASE_TIMEOUT_THRESHOLD;
                if (diff > threshold) {
                    console.error(`Instance creation timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                    // Update the lease status of the request to 'SashiTimeout'.
                    await this.updateLeaseStatus(acquireRefId, LeaseStatus.SASHI_TIMEOUT);
                    await this.destroyInstance(createRes.content.name, tenantAddress, leaseIndex);
                } else {
                    console.log(`Instance created for ${tenantAddress}`);

                    // Save the value to a local variable to prevent the value being updated between two calls ending up with two different values.
                    const currentLedgerIndex = this.lastValidatedLedgerIndex;

                    // Add to in-memory expiry list, so the instance will get destroyed when the moments exceed,
                    this.addToExpiryList(acquireRefId, createRes.content.name, tenantAddress, this.getExpiryLedger(currentLedgerIndex, moments));

                    // Update the database for acquired record.
                    await this.updateAcquiredRecord(acquireRefId, currentLedgerIndex);

                    // Update the active instance count.
                    this.activeInstanceCount++;
                    await this.hostClient.updateRegInfo(this.activeInstanceCount);

                    // Send the acquire response with created instance info.
                    await this.hostClient.acquireSuccess(acquireRefId, tenantAddress, createRes);
                }
            }
        }
        catch (e) {
            console.error(e);

            // Update the lease response for failures (Only if the request validated and ACQUIRING record is added).
            if (requestValidated)
                await this.updateLeaseStatus(acquireRefId, LeaseStatus.FAILED).catch(console.error);

            // Destroy the instance if created.
            if (createRes)
                await this.sashiCli.destroyInstance(createRes.content.name).catch(console.error);

            // Re-create the lease offer (Only if the nft belongs to this request has a lease index).
            if (leaseIndex >= 0)
                await this.recreateLeaseOffer(nfTokenId, tenantAddress, leaseIndex).catch(console.error);

            // Send error transaction with received leaseAmount.
            await this.hostClient.acquireError(acquireRefId, tenantAddress, leaseAmount, e.content || 'invalid_acquire_lease').catch(console.error);
        }
        finally {
            this.db.close();
        }
    }

    async destroyInstance(containerName, tenantAddress, leaseIndex) {
        // Destroy the instance.
        await this.sashiCli.destroyInstance(containerName);
        await this.recreateLeaseOffer(containerName, tenantAddress, leaseIndex).catch(console.error);
    }

    async handleExtendLease(r) {

        this.db.open();

        const extendRefId = r.extendRefId;
        const nfTokenId = r.nfTokenId;
        const tenantAddress = r.tenant;
        const amount = r.payment;

        try {

            if (r.transaction.Destination !== this.cfg.xrpl.address)
                throw "Invalid destination";

            const tenantAcc = new evernode.XrplAccount(tenantAddress);
            const hostingNft = (await tenantAcc.getNfts()).find(n => n.NFTokenID === nfTokenId && n.URI.startsWith(evernode.EvernodeConstants.LEASE_NFT_PREFIX_HEX));

            if (!hostingNft)
                throw "The NFT ownership verification was failed in the lease extension process";

            const uriInfo = evernode.UtilHelpers.decodeLeaseNftUri(hostingNft.URI);
            const leaseAmount = uriInfo.leaseAmount;
            if (leaseAmount <= 0)
                throw "Invalid per moment lease amount";

            const extendingMoments = Math.floor(amount / leaseAmount);

            if (extendingMoments < 1)
                throw "The transaction does not satisfy the minimum extendable moments";

            const instanceSearchCriteria = { tenant_xrp_address: tenantAddress, container_name: hostingNft.NFTokenID };

            const instance = (await this.getLeaseRecords(instanceSearchCriteria)).find(i => (i.status === LeaseStatus.ACQUIRED || i.status === LeaseStatus.EXTENDED));

            if (!instance)
                throw "No relevant instance was found to perform the lease extension";

            console.log(`Received extend lease from ${tenantAddress}`);

            let expiryItemFound = false;
            let expiryMoment;

            for (const item of this.expiryList) {
                if (item.containerName === instance.container_name) {
                    item.expiryLedger = this.getExpiryLedger(item.expiryLedger, extendingMoments);
                    expiryMoment = (await this.hostClient.getMoment(item.expiryLedger));

                    let obj = {
                        status: LeaseStatus.EXTENDED,
                        life_moments: (instance.life_moments + extendingMoments)
                    };
                    await this.updateLeaseData(instance.tx_hash, obj);
                    expiryItemFound = true;
                    break;
                }
            }

            if (!expiryItemFound)
                throw "No matching expiration record was found for the instance";

            // Send the extend success response
            await this.hostClient.extendSuccess(extendRefId, tenantAddress, expiryMoment);

        }
        catch (e) {
            console.error(e);
            // Send the extend error response
            await this.hostClient.extendError(extendRefId, tenantAddress, e.content || 'invalid_extend_lease', amount);
        } finally {
            this.db.close();
        }
    }

    addToExpiryList(txHash, containerName, tenant, expiryLedger) {
        this.expiryList.push({
            txHash: txHash,
            containerName: containerName,
            tenant: tenant,
            expiryLedger: expiryLedger,
        });
        console.log(`Container ${containerName} expiry set at ledger ${expiryLedger}`);
    }

    async createLeaseTableIfNotExists() {
        // Create table if not exists.
        await this.db.createTableIfNotExists(this.leaseTable, [
            { name: 'timestamp', type: DataTypes.INTEGER, notNull: true },
            { name: 'tx_hash', type: DataTypes.TEXT, primary: true, notNull: true },
            { name: 'tenant_xrp_address', type: DataTypes.TEXT, notNull: true },
            { name: 'life_moments', type: DataTypes.INTEGER, notNull: true },
            { name: 'container_name', type: DataTypes.TEXT },
            { name: 'created_on_ledger', type: DataTypes.INTEGER },
            { name: 'status', type: DataTypes.TEXT, notNull: true }
        ]);
    }

    async createUtilDataTableIfNotExists() {
        // Create table if not exists.
        await this.db.createTableIfNotExists(this.utilTable, [
            { name: 'name', type: DataTypes.TEXT, notNull: true },
            { name: 'value', type: DataTypes.INTEGER, notNull: true }
        ]);
        await this.createLastWatchedLedgerEntryIfNotExists();
    }

    async createLastWatchedLedgerEntryIfNotExists() {
        const ret = await this.db.getValues(this.utilTable, { name: appenv.LAST_WATCHED_LEDGER });
        if (ret.length === 0) {
            await this.db.insertValue(this.utilTable, { name: appenv.LAST_WATCHED_LEDGER, value: -1 });
        }
    }

    async getAcquiredRecords() {
        return (await this.db.getValues(this.leaseTable, { status: LeaseStatus.ACQUIRED }));
    }

    async getLeaseRecords(searchCriteria = null) {
        if (searchCriteria)
            return (await this.db.getValues(this.leaseTable, searchCriteria));

        return (await this.db.getValues(this.leaseTable));
    }

    async createLeaseRecord(txHash, txTenantAddress, containerName, moments) {
        await this.db.insertValue(this.leaseTable, {
            timestamp: Date.now(),
            tx_hash: txHash,
            tenant_xrp_address: txTenantAddress,
            life_moments: moments,
            container_name: containerName,
            status: LeaseStatus.ACQUIRING
        });
    }

    async updateLastIndexRecord(ledger_idx) {
        await this.db.updateValue(this.utilTable, {
            value: ledger_idx,
        }, { name: appenv.LAST_WATCHED_LEDGER });
    }

    async updateAcquiredRecord(txHash, ledgerIndex) {
        await this.db.updateValue(this.leaseTable, {
            created_on_ledger: ledgerIndex,
            status: LeaseStatus.ACQUIRED
        }, { tx_hash: txHash });
    }

    async updateLeaseStatus(txHash, status) {
        await this.db.updateValue(this.leaseTable, { status: status }, { tx_hash: txHash });
    }

    /**
     * Sample savingData
     * Note : The keys of the object should match with the sqlite db column names
     * {
     *      status: "XXXX",
     *      life_moments: 1
     * }
     */

    async updateLeaseData(txHash, savingData = null) {
        if (savingData)
            await this.db.updateValue(this.leaseTable, savingData, { tx_hash: txHash });
    }

    async deleteLeaseRecord(txHash) {
        await this.db.deleteValues(this.leaseTable, { tx_hash: txHash });
    }

    getExpiryLedger(ledgerIndex, moments) {
        return ledgerIndex + moments * this.hostClient.config.momentSize;
    }

    readConfig() {
        this.cfg = ConfigHelper.readConfig(this.configPath, this.secretConfigPath);
    }

    persistConfig() {
        ConfigHelper.writeConfig(this.cfg, this.configPath, this.secretConfigPath);
    }
}

module.exports = {
    MessageBoard
}