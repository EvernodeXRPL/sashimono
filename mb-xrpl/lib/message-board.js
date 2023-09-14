const fs = require('fs');
const evernode = require('evernode-js-client');
const { SqliteDatabase, DataTypes } = require('./sqlite-handler');
const { appenv } = require('./appenv');
const { SashiCLI } = require('./sashi-cli');
const { ConfigHelper } = require('./config-helper');
const { GovernanceManager } = require('./governance-manager');

const LeaseStatus = {
    ACQUIRING: 'Acquiring',
    ACQUIRED: 'Acquired',
    FAILED: 'Failed',
    EXPIRED: 'Expired',
    SASHI_TIMEOUT: 'SashiTimeout',
    EXTENDED: 'Extended'
}

class MessageBoard {
    #leaseUpdateLock = false; // This locking mechanism is temporary, can be removed when acquire queue is implemented
    #xrplHalted = false;
    #graceThreshold = 0.25;
    #haltTimeout = 60; // In seconds
    #instanceExpirationQueue = [];
    #graceTimeoutRef = null;
    #lastHaltedTime = null;
    #concurrencyQueue = {
        processing: false,
        queue: []
    };

    constructor(configPath, secretConfigPath, dbPath, sashiCliPath, sashiDbPath, sashiConfigPath) {
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
        this.sashiDb = new SqliteDatabase(sashiDbPath);
        this.sashiTable = appenv.SASHI_TABLE_NAME;
        this.sashiConfigPath = sashiConfigPath;
        this.governanceManager = new GovernanceManager(appenv.GOVERNANCE_CONFIG_PATH);
    }

    async init() {
        this.readConfig();
        if (!this.cfg.version || !this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.governorAddress)
            throw "Required cfg fields cannot be empty.";

        this.xrplApi = new evernode.XrplApi(this.cfg.xrpl.rippledServer);
        evernode.Defaults.set({
            governorAddress: this.cfg.xrpl.governorAddress,
            xrplApi: this.xrplApi
        })
        await this.xrplApi.connect();

        this.hostClient = new evernode.HostClient(this.cfg.xrpl.address, this.cfg.xrpl.secret);
        await this.#connectHost();

        console.log("Using,");
        console.log("\tGovernor account " + this.cfg.xrpl.governorAddress);
        console.log("\tRegistry account " + this.hostClient.config.registryAddress);
        console.log("\tHeartbeat account " + this.hostClient.config.heartbeatAddress);
        console.log("Using rippled " + this.cfg.xrpl.rippledServer);

        // Get last heartbeat moment from the host info.
        let hostInfo = await this.hostClient.getRegistration();
        if (!hostInfo)
            throw "Host is not registered.";

        this.regClient = await evernode.HookClientFactory.create(evernode.HookTypes.registry);

        await this.#connectRegistry();
        await this.regClient.subscribe();

        // Get moment only if heartbeat info is not 0.
        this.lastHeartbeatMoment = hostInfo.lastHeartbeatIndex ? await this.hostClient.getMoment(hostInfo.lastHeartbeatIndex) : 0;

        this.db.open();
        // Create lease table if not exist.
        await this.createLeaseTableIfNotExists();
        await this.createUtilDataTableIfNotExists();

        this.lastValidatedLedgerIndex = this.xrplApi.ledgerIndex;

        const leaseRecords = (await this.getLeaseRecords()).filter(r => (r.status === LeaseStatus.ACQUIRED || r.status === LeaseStatus.EXTENDED));
        for (const lease of leaseRecords)
            this.addToExpiryList(lease.tx_hash, lease.container_name, lease.tenant_xrp_address, this.getExpiryTimestamp(lease.timestamp, lease.life_moments));

        // Catch up missed transactions based on the previously updated "last_watched_ledger" record (checkpoint).
        await this.#catchupMissedLeases().catch(console.error);

        this.db.close();

        // Load the sashimono config.
        const sashiConfig = ConfigHelper.readSashiConfig(this.sashiConfigPath);
        this.activeInstanceCount = this.expiryList.length;
        console.log(`Active instance count: ${this.activeInstanceCount}`);

        await this.#queueAction(async () => {
            // Update the registry with the active instance count.
            await this.hostClient.updateRegInfo(this.activeInstanceCount, this.cfg.version, sashiConfig.system.max_instance_count, null, null,
                sashiConfig.system.max_cpu_us, Math.floor((sashiConfig.system.max_mem_kbytes + sashiConfig.system.max_swap_kbytes) / 1000),
                Math.floor(sashiConfig.system.max_storage_kbytes / 1000));
        });

        this.xrplApi.on(evernode.XrplApiEvents.LEDGER, async (e) => {
            this.lastValidatedLedgerIndex = e.ledger_index;
            this.lastLedgerTime = evernode.UtilHelpers.getCurrentUnixTime('milli');
        });

        this.hostClient.on(evernode.HostEvents.AcquireLease, r => this.handleAcquireLease(r));
        this.hostClient.on(evernode.HostEvents.ExtendLease, r => this.handleExtendLease(r));

        const checkAndRequestRebate = async () => {
            await this.#queueAction(async () => {
                // Send rebate request at startup if there's any pending rebates.
                if (hostInfo?.registrationFee > hostRegFee) {
                    console.log(`Requesting rebate...`);
                    await this.hostClient.requestRebate();
                }
            });
        }

        let hostRegFee = this.hostClient.config.hostRegFee;
        await checkAndRequestRebate();

        // Listen to the host registrations and send rebate requests if registration fee updated.
        this.regClient.on(evernode.RegistryEvents.HostRegistered, async r => {
            await this.hostClient.refreshConfig();
            if (hostRegFee != this.hostClient.config.hostRegFee) {
                hostRegFee = this.hostClient.config.hostRegFee;
                hostInfo = await this.hostClient.getRegistration();
                await checkAndRequestRebate();
            }
        });

        // Start a job to expire instances and check for halts
        this.#startSashimonoClockScheduler();

        // Start heartbeat job
        this.#startHeartBeatScheduler();

        // Start a job to prune the orphan instances.
        this.#startPruneScheduler();

    }

    // Try to acquire the lease update lock.
    async #acquireConcurrencyQueue() {
        await new Promise(async resolve => {
            while (this.#concurrencyQueue.processing) {
                await new Promise(resolveSleep => {
                    setTimeout(resolveSleep, 1000);
                })
            }
            resolve();
        });
        this.#concurrencyQueue.processing = true;
    }

    // Release the lease update lock.
    async #releaseConcurrencyQueue() {
        this.#concurrencyQueue.processing = false;
    }

    async #queueAction(action) {
        await this.#acquireConcurrencyQueue();

        this.#concurrencyQueue.queue.push({
            callback: action,
            attempts: 0
        });

        await this.#releaseConcurrencyQueue();
    }

    async #processConcurrencyQueue() {
        await this.#acquireConcurrencyQueue();

        let toKeep = [];
        for (let action of this.#concurrencyQueue.queue) {
            try {
                await action.callback();
            }
            catch (e) {
                if (action.attempts < 5) {
                    action.attempts++;
                    toKeep.push(action);
                }
                else {
                    console.error(e);
                }
            }
        }
        this.#concurrencyQueue.queue = toKeep;

        await this.#releaseConcurrencyQueue();
    }

    // Check for xrpl halts
    #checkLedgersForHalt() {
        const currentTime = evernode.UtilHelpers.getCurrentUnixTime('milli');
        const lastLedgerTimeDifference = currentTime - this.lastLedgerTime;

        if (lastLedgerTimeDifference >= this.#haltTimeout * 1000) {
            if (!this.#xrplHalted) {
                this.#xrplHalted = true;
                this.#lastHaltedTime = this.lastLedgerTime;
            } else if (this.#graceTimeoutRef) {
                clearTimeout(this.#graceTimeoutRef);
                this.#graceTimeoutRef = null;
            }
        }

        if (this.#xrplHalted && lastLedgerTimeDifference < (this.#haltTimeout * 1000) && !this.#graceTimeoutRef) {
            const haltedDuration = currentTime - this.#lastHaltedTime; // in milliSec
            const gracePeriod = haltedDuration * this.#graceThreshold;
            this.#graceTimeoutRef = setTimeout(() => {
                this.#xrplHalted = false;
                this.#graceTimeoutRef = null;
            }, gracePeriod);
        }
    }

    // Expire leases
    async #expireInstances() {
        const currentTime = evernode.UtilHelpers.getCurrentUnixTime();

        // Filter out instances which needed to be expired and destroy them.
        const expired = this.expiryList.filter(x => x.expiryTimestamp < currentTime);
        if (expired && expired.length) {
            console.log(`Starting the expiring instances job...`);
            this.#instanceExpirationQueue.push(...expired);
            this.expiryList = this.expiryList.filter(x => x.expiryTimestamp >= currentTime);
        }

        if (!this.#xrplHalted && this.#instanceExpirationQueue.length) {
            this.db.open();
            await this.#acquireLeaseUpdateLock();
            for (let item of this.#instanceExpirationQueue) {
                try {
                    if (!this.#xrplHalted) {
                        await this.#expireInstance(item, currentTime);
                        // Remove from the queue
                        this.#instanceExpirationQueue = this.#instanceExpirationQueue.filter(i => i.containerName != item.containerName);
                    }
                    else {
                        console.log("XRPL is halted.")
                        break;
                    }
                }
                catch (e) {
                    console.log(`Error "${e}", occurred in expiring the item : ${item}.`)
                }
            }
            await this.#releaseLeaseUpdateLock();
            this.db.close();
            console.log(`Stopping the expiring instances job...`);
        }
    }

    // Heartbeat sender
    async #sendHeartbeat() {
        await this.#queueAction(async () => {
            let ongoingHeartbeat = false;
            const currentMoment = await this.hostClient.getMoment();

            // Sending heartbeat every CONF_HOST_HEARTBEAT_FREQ moments.
            if (!ongoingHeartbeat &&
                (this.lastHeartbeatMoment === 0 || (currentMoment % this.hostClient.config.hostHeartbeatFreq === 0 && currentMoment !== this.lastHeartbeatMoment))) {
                ongoingHeartbeat = true;
                console.log(`Reporting heartbeat at Moment ${currentMoment}...`);

                // Send heartbeat with votes, if there are votes in the config.
                let heartbeatSent = false;
                const votes = this.governanceManager.getVotes();
                if (votes) {
                    const voteArr = (await Promise.all(Object.entries(votes).map(async ([key, value]) => {
                        const candidate = await this.hostClient.getCandidateById(key);
                        // Delete candidate vote if there's no such candidate.
                        if (!candidate) {
                            this.governanceManager.clearCandidate(key);
                            return null;
                        }
                        return {
                            candidate: candidate.uniqueId,
                            vote: value === evernode.EvernodeConstants.CandidateVote.Support ?
                                evernode.EvernodeConstants.CandidateVote.Support :
                                evernode.EvernodeConstants.CandidateVote.Reject,
                            idx: candidate.index
                        };
                    }))).filter(v => v).sort((a, b) => a.idx - b.idx);
                    if (voteArr && voteArr.length) {
                        for (const vote of voteArr) {
                            try {
                                await this.hostClient.heartbeat(vote);
                                this.lastHeartbeatMoment = await this.hostClient.getMoment();
                                heartbeatSent = true;
                            }
                            catch (e) {
                                // Remove candidate from config in vote validation from the hook failed.
                                if (e.code === 'VOTE_VALIDATION_ERR') {
                                    console.error(e.error);
                                    this.governanceManager.clearCandidate(vote.candidate);
                                }
                                else {
                                    console.error("Heartbeat tx with vote error", e);
                                }
                            }
                        }
                    }
                }

                // Return if at-least one heartbeat has been sent. Otherwise send heartbeat without votes.
                if (heartbeatSent)
                    return;

                try {
                    await this.hostClient.heartbeat();
                    this.lastHeartbeatMoment = await this.hostClient.getMoment();
                }
                catch (err) {
                    if (err.code === 'tecHOOK_REJECTED')
                        console.log("Heartbeat rejected by the hook.");
                    else
                        console.log("Heartbeat tx error", err);
                }
                finally {
                    ongoingHeartbeat = false;
                }
            }
        });
    }

    async #expireInstance(lease, currentTime = evernode.UtilHelpers.getCurrentUnixTime()) {
        try {
            console.log(`Moments exceeded (current timestamp:${currentTime}, expiry timestamp:${lease.expiryTimestamp}). Destroying ${lease.containerName}`);
            // Expire the current lease agreement (Burn the instance URIToken) and re-minting and creating sell offer for the same lease index.
            const uriToken = (await (new evernode.XrplAccount(lease.tenant)).getURITokens())?.find(n => n.index == lease.containerName);
            // If there's no uriToken for this record it should be already burned and instance is destroyed, So we only delete the record.
            if (!uriToken)
                console.log(`Cannot find an URIToken for ${lease.containerName}`);
            else {
                const uriInfo = evernode.UtilHelpers.decodeLeaseTokenUri(uriToken.URI);
                await this.destroyInstance(lease.containerName, lease.tenant, uriInfo.leaseIndex, uriInfo.ipv6Address);
            }

            this.activeInstanceCount--;
            /**
             * Soft deletion for debugging purpose.
             */
            // await this.updateLeaseStatus(x.txHash, LeaseStatus.EXPIRED);

            // Delete the lease record related to this instance (Permanent Delete).
            await this.deleteLeaseRecord(lease.txHash);

            // Remove from the queue
            this.#instanceExpirationQueue = this.#instanceExpirationQueue.filter(i => i.containerName != lease.containerName);

            await this.#queueAction(async () => {
                await this.hostClient.updateRegInfo(this.activeInstanceCount);
            });
            console.log(`Destroyed ${lease.containerName}`);

        }
        catch (e) {
            console.error(e);
        }
    }

    // Connect the host and trying to reconnect in the event of account not found error.
    // Account not found error can be because of a network reset. (Dev and test nets)
    async #connect(client) {
        let attempts = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                attempts++;
                const ret = await client.connect();
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

    async #connectHost() {
        await this.#connect(this.hostClient);
    }

    async #connectRegistry() {
        await this.#connect(this.regClient);
    }

    #startPruneScheduler() {
        const timeout = appenv.ORPHAN_PRUNE_SCHEDULER_INTERVAL_HOURS * 3600000; // Hours to millisecs.

        const scheduler = async () => {
            console.log(`Starting the scheduled prune job...`);
            await this.#acquireLeaseUpdateLock();
            await this.#pruneOrphanLeases().catch(console.error).finally(async () => {
                await this.#releaseLeaseUpdateLock();
            });
            console.log(`Stopped the scheduled prune job.`);
            setTimeout(async () => {
                await scheduler();
            }, timeout);
        };

        setTimeout(async () => {
            await scheduler();
        }, timeout);
    }

    #startSashimonoClockScheduler() {
        const timeout = appenv.SASHIMONO_SCHEDULER_INTERVAL_SECONDS * 1000; // Seconds to millisecs.

        const scheduler = async () => {
            this.#checkLedgersForHalt();
            await this.#expireInstances();
            await this.#processConcurrencyQueue();
            setTimeout(async () => {
                await scheduler();
            }, timeout);
        };

        setTimeout(async () => {
            await scheduler();
        }, timeout);
    }

    async #startHeartBeatScheduler() {
        // Sending a heartbeat at startup
        await this.#sendHeartbeat();

        const momentSize = this.hostClient.config.momentSize;
        const halfMomentSize = momentSize / 2; // Getting half of moment size
        const timeout = momentSize * 1000; // Converting seconds to milliseconds.

        const scheduler = async () => {
            setTimeout(async () => {
                await scheduler();
            }, timeout);
            await this.#sendHeartbeat();
        };

        const currentMomentStartIdx = await this.hostClient.getMomentStartIndex();

        // If the start index is in the begining of the moment, delay the heartbeat scheduler 1 minute to make sure the hook timestamp is not in previous moment when accepting the heartbeat.
        const startTimeout = (evernode.UtilHelpers.getCurrentUnixTime() - currentMomentStartIdx) < halfMomentSize ? ((momentSize + 60) * 1000) : ((momentSize) * 1000);

        setTimeout(async () => {
            await scheduler();
        }, startTimeout);
    }

    // Try to acquire the lease update lock.
    async #acquireLeaseUpdateLock() {
        await new Promise(async resolve => {
            while (this.#leaseUpdateLock) {
                await new Promise(resolveSleep => {
                    setTimeout(resolveSleep, 1000);
                })
            }
            resolve();
        });
        this.#leaseUpdateLock = true;
    }

    // Release the lease update lock.
    async #releaseLeaseUpdateLock() {
        this.#leaseUpdateLock = false;
    }

    async #pruneOrphanLeases() {
        // Note: If this is soft deletion we need to handle the destroyed status and replace deleteLeaseRecord with changing the status.

        // Get the records which are created before an acquire timeout x 2.
        // leaseAcqureWindow is in seconds.
        const timeoutSecs = (this.hostClient.config.leaseAcquireWindow * appenv.ACQUIRE_LEASE_TIMEOUT_THRESHOLD) * 2;
        const timeMargin = new Date(Date.now() - (1000 * timeoutSecs));

        this.sashiDb.open();
        const instances = (await this.sashiDb.getValues(this.sashiTable));
        this.sashiDb.close();
        this.db.open();
        const leases = (await this.db.getValues(this.leaseTable));
        this.db.close();

        let activeInstanceCount = leases.filter(r => (r.status === LeaseStatus.ACQUIRED || r.status === LeaseStatus.EXTENDED)).length;

        // Remove the instances which are orphan.
        // Only consider the older ones.
        for (const instance of instances.filter(i => i.time < timeMargin)) {
            try {
                const leaseIndex = leases.findIndex(l => l.container_name === instance.name);
                const lease = leaseIndex >= 0 ? leases[leaseIndex] : null;
                // If there's a lease record this is created from message board.
                if (lease) {
                    leases.splice(leaseIndex, 1);
                    const uriToken = (await (new evernode.XrplAccount(lease.tenant_xrp_address)).getURITokens())?.find(n => n.index == instance.name);

                    // If lease is in ACQUIRING status acquire response is not received by the tenant and lease is not in expiry list.
                    // If the URIToken is not owned by the tenant we destroy the instance since this is not a valid lease.
                    // In these cases, destroy the instance.
                    if (lease.status === LeaseStatus.ACQUIRING || !uriToken) {
                        console.log(`Pruning orphan instance ${instance.name}...`);
                        await this.sashiCli.destroyInstance(instance.name);

                        // After destroying, If the URIToken is owned by the tenant, burn the URIToken and recreate and refund the tenant.
                        if (uriToken) {
                            const uriInfo = evernode.UtilHelpers.decodeLeaseTokenUri(uriToken.URI);
                            await this.recreateLeaseOffer(instance.name, lease.tenant_xrp_address, uriInfo.leaseIndex, uriInfo.ipv6Address);

                            await this.#queueAction(async () => {
                                console.log(`Refunding tenant ${lease.tenant_xrp_address}...`);
                                await this.hostClient.refundTenant(lease.tx_hash, lease.tenant_xrp_address, uriInfo.leaseAmount.toString());
                            });
                        }

                        // Remove the lease record.
                        if (lease) {
                            this.db.open();
                            await this.deleteLeaseRecord(lease.tx_hash);
                            this.db.close();

                            if (lease.status === LeaseStatus.ACQUIRED || lease.status === LeaseStatus.EXTENDED)
                                activeInstanceCount--;
                        }
                    }
                }
            }
            catch (e) {
                console.error(e);
            }
        }

        // Remove the leases which are orphan (Does not have an instance).
        // Only consider the older ones.
        for (const lease of leases.filter(l => l.timestamp < timeMargin && (l.status === LeaseStatus.ACQUIRING || l.status === LeaseStatus.ACQUIRED || l.status === LeaseStatus.EXTENDED))) {
            try {
                // If lease does not have an instance.
                this.sashiDb.open();
                const instances = (await this.sashiDb.getValues(this.sashiTable, { name: lease.container_name }));
                this.sashiDb.close();

                if (!instances || instances.length === 0) {
                    console.log(`Pruning orphan lease ${lease.container_name}...`);

                    this.db.open();
                    await this.deleteLeaseRecord(lease.tx_hash);
                    this.db.close();

                    if (lease.status === LeaseStatus.ACQUIRED || lease.status === LeaseStatus.EXTENDED)
                        activeInstanceCount--;

                    const uriToken = (await (new evernode.XrplAccount(lease.tenant_xrp_address)).getURITokens())?.find(n => n.index == lease.container_name);
                    if (uriToken) {
                        const uriInfo = evernode.UtilHelpers.decodeLeaseTokenUri(uriToken.URI);
                        await this.recreateLeaseOffer(lease.container_name, lease.tenant_xrp_address, uriInfo.leaseIndex, uriInfo.ipv6Address);

                        await this.#queueAction(async () => {
                            // If lease is in ACQUIRING status acquire response is not received by the tenant and lease is not in expiry list.
                            if (lease.status === LeaseStatus.ACQUIRING) {
                                console.log(`Refunding tenant ${lease.tenant_xrp_address}...`);
                                await this.hostClient.refundTenant(lease.tx_hash, lease.tenant_xrp_address, uriInfo.leaseAmount.toString());
                            }
                        });
                    }
                }
            }
            catch (e) {
                console.error(e);
            }
        }

        await this.#queueAction(async () => {
            // If active instance count is updated, Send the update registration transaction.
            if (this.activeInstanceCount !== activeInstanceCount) {
                this.activeInstanceCount = activeInstanceCount;
                await this.hostClient.updateRegInfo(this.activeInstanceCount);
            }
        });
    }

    async #catchupMissedLeases() {
        const fullHistoryXrplApi = new evernode.XrplApi(appenv.DEFAULT_FULL_HISTORY_NODE);
        await fullHistoryXrplApi.connect();

        this.db.open();
        const leases = (await this.db.getValues(this.leaseTable));
        this.db.close();

        try {
            const lastWatchedLedger = await this.db.getValues(this.utilTable, { name: appenv.LAST_WATCHED_LEDGER });
            if (lastWatchedLedger && lastWatchedLedger[0]?.value != "NULL") {
                const hostAccount = await new evernode.XrplAccount(this.cfg.xrpl.address, this.cfg.xrpl.secret, { xrplApi: fullHistoryXrplApi });
                const transactionHistory = await hostAccount.getAccountTrx(lastWatchedLedger[0].value, -1);

                const transactions = transactionHistory.map((record) => {
                    const transaction = record.tx;
                    transaction.Memos = evernode.TransactionHelper.deserializeMemos(transaction.Memos);
                    transaction.HookParameters = evernode.TransactionHelper.deserializeHookParams(transaction.HookParameters);
                    return transaction;
                });

                loop1:
                for (const trx of transactions) {
                    try {
                        const paramValues = trx.HookParameters.map(p => p.value);
                        if (paramValues.includes(evernode.EventTypes.ACQUIRE_LEASE) || paramValues.includes(evernode.EventTypes.EXTEND_LEASE)) {
                            // Update last watched ledger sequence number.
                            await this.updateLastIndexRecord(trx.ledger_index);

                            // Avoid re-refunding possibility.
                            if (trx.ledger_index === lastWatchedLedger[0]?.value) {

                                for (const tx of transactions) {
                                    // Skip, if this transaction was previously considered.
                                    const acquireRef = this.#getTrxHookParams(tx, evernode.EventTypes.ACQUIRE_SUCCESS);
                                    if (acquireRef === trx.hash)
                                        continue loop1;

                                    const extendRef = this.#getTrxHookParams(tx, evernode.EventTypes.EXTEND_SUCCESS);
                                    if (extendRef === trx.hash)
                                        continue loop1;

                                    const refundRef = this.#getTrxHookParams(tx, evernode.EventTypes.REFUND);
                                    if (refundRef === trx.hash)
                                        continue loop1;
                                }
                            }

                            trx.Destination = this.cfg.xrpl.address;

                            // Handle Acquires.
                            if (paramValues.includes(evernode.EventTypes.ACQUIRE_LEASE)) {

                                // Find and bind the bought lease offer (If the trx. is  an ACQUIRE, it should be an URITokenBuy trx)
                                const offer = (await hostAccount.getURITokens({ ledger_index: trx.ledger_index - 1 }))?.find(o => o.index === trx?.URITokenID && o.Amount);
                                if (!trx.URITokenSellOffer)
                                    trx.URITokenSellOffer = offer;

                                const eventInfo = await this.hostClient.extractEvernodeEvent(trx);

                                const lease = leases.find(l => l.container_name === eventInfo.data.uriTokenId && (l.status === LeaseStatus.ACQUIRED || l.status === LeaseStatus.EXTENDED));

                                if (!lease) {
                                    const tenantXrplAcc = new evernode.XrplAccount(eventInfo.data.tenant);
                                    const uriToken = (await tenantXrplAcc.getURITokens()).find(n => evernode.EvernodeHelpers.isValidURI(n.URI, evernode.EvernodeConstants.LEASE_TOKEN_PREFIX_HEX) && n.index === eventInfo.data.uriTokenId);
                                    if (uriToken) {
                                        const uriInfo = evernode.UtilHelpers.decodeLeaseTokenUri(uriToken.URI);
                                        // Have to recreate the URIToken Offer for the lease as previous one was not utilized.
                                        await this.recreateLeaseOffer(eventInfo.data.uriTokenId, eventInfo.data.tenant, uriInfo.leaseIndex, uriInfo.ipv6Address);

                                        await this.#queueAction(async () => {
                                            console.log(`Refunding tenant ${eventInfo.data.tenant} for acquire...`);
                                            await this.hostClient.refundTenant(trx.hash, eventInfo.data.tenant, uriInfo.leaseAmount.toString());
                                        });
                                    }
                                }

                            } else if (paramValues.includes(evernode.EventTypes.EXTEND_LEASE)) { // Handle Extensions.

                                const eventInfo = await this.hostClient.extractEvernodeEvent(trx);

                                const lease = leases.find(l => l.container_name === eventInfo.data.uriTokenId && (l.status === LeaseStatus.ACQUIRED || l.status === LeaseStatus.EXTENDED));

                                if (lease) {
                                    const tenantXrplAcc = new evernode.XrplAccount(eventInfo.data.tenant);
                                    const uriToken = (await tenantXrplAcc.getURITokens()).find(n => evernode.EvernodeHelpers.isValidURI(n.URI, evernode.EvernodeConstants.LEASE_TOKEN_PREFIX_HEX) && n.index === eventInfo.data.uriTokenId);
                                    if (uriToken) {
                                        await this.#queueAction(async () => {
                                            // The refund for the extension, if tenant still own the URIToken.
                                            console.log(`Refunding tenant ${eventInfo.data.tenant} for extend...`);
                                            await this.hostClient.refundTenant(trx.hash, eventInfo.data.tenant, eventInfo.data.payment.toString());
                                        });
                                    } else {
                                        console.log(`No such URIToken (${eventInfo.data.uriTokenId}) was found.`);
                                    }
                                } else {
                                    console.log(`No lease was found: (URIToken : ${eventInfo.data.uriTokenId}).`);
                                }
                            }
                        }
                    } catch (e) {
                        console.error(e);
                    }
                }
            }
        } catch (e) {
            console.error(e);
        } finally {
            await fullHistoryXrplApi.disconnect();
        }

    }

    #getTrxHookParams(txn, paramName) {
        const hookParams = txn.HookParameters;

        if (hookParams.length > 1 && hookParams[0]?.value == paramName)
            return hookParams[1]?.value

        return null;
    }

    async recreateLeaseOffer(uriTokenId, tenantAddress, leaseIndex, ipv6Address = null) {
        await this.#queueAction(async () => {
            // Burn the URIToken and recreate the offer.
            await this.hostClient.expireLease(uriTokenId, tenantAddress).catch(console.error);
            // We refresh the config here, So if the purchaserTargetPrice is updated by the purchaser service, the new value will be taken.
            await this.hostClient.refreshConfig();
            const leaseAmount = this.cfg.xrpl.leaseAmount ? this.cfg.xrpl.leaseAmount : parseFloat(this.hostClient.config.purchaserTargetPrice);
            await this.hostClient.offerLease(leaseIndex, leaseAmount, appenv.TOS_HASH, ipv6Address).catch(console.error);
        });
    }

    async handleAcquireLease(r) {

        const acquireRefId = r.acquireRefId; // Acquire tx hash.
        const uriTokenId = r.uriTokenId;
        const leaseAmount = parseFloat(r.leaseAmount);
        const tenantAddress = r.tenant;
        let requestValidated = false;
        let createRes;
        let leaseIndex = -1; // Lease index cannot be negative, So we keep initial non populated value as -1.
        let instanceIPv6Address = null;


        this.db.open();

        try {
            await this.#acquireLeaseUpdateLock();

            if (r.host !== this.cfg.xrpl.address)
                throw "Invalid host in the lease aquire.";

            // Update last watched ledger sequence number.
            await this.updateLastIndexRecord(r.transaction.LedgerIndex);

            // Get the existing uriToken of the lease.

            const uriToken = (await (new evernode.XrplAccount(tenantAddress)).getURITokens())?.find(n => n.index == uriTokenId);
            if (!uriToken)
                throw 'Could not find the uriToken for lease acquire request.';

            const uriInfo = evernode.UtilHelpers.decodeLeaseTokenUri(uriToken.URI);
            instanceIPv6Address = uriInfo.ipv6Address;

            if (leaseAmount != uriInfo.leaseAmount)
                throw 'URIToken embedded lease amount and acquire lease amount does not match.';
            leaseIndex = uriInfo.leaseIndex;

            // Since acquire is accepted for leaseAmount
            const moments = 1;

            // Use URITokenID as the instance name.
            const containerName = uriTokenId;
            console.log(`Received acquire lease from ${tenantAddress}`);
            requestValidated = true;
            await this.createLeaseRecord(acquireRefId, tenantAddress, containerName, moments);

            // The last validated ledger when we receive the acquire request.
            const startingValidatedTime = evernode.UtilHelpers.getCurrentUnixTime();

            // Wait until the sashi cli is available.
            await this.sashiCli.wait();

            // Number of validated ledgers passed while processing the last request.
            let diff = evernode.UtilHelpers.getCurrentUnixTime() - startingValidatedTime;
            // Give-up the acquiring process if processing the last request takes more than 40% of allowed window(Window is in seconds).
            let threshold = this.hostClient.config.leaseAcquireWindow * appenv.ACQUIRE_LEASE_WAIT_TIMEOUT_THRESHOLD;
            if (diff > threshold) {
                console.error(`Sashimono busy timeout. Took: ${diff} seconds. Threshold: ${threshold} seconds`);
                // Update the lease status of the request to 'SashiTimeout'.
                await this.updateAcquireStatus(acquireRefId, LeaseStatus.SASHI_TIMEOUT);
                await this.recreateLeaseOffer(uriTokenId, tenantAddress, leaseIndex, uriInfo.ipv6Address);
            }
            else {
                const instanceRequirements = (uriInfo.ipv6Address) ? { ...r.payload, outbound_ipv6: uriInfo.ipv6Address, outbound_net_interface: this.cfg.networking.ipv6.interface } : r.payload;
                createRes = await this.sashiCli.createInstance(containerName, instanceRequirements);

                // Number of validated ledgers passed while the instance is created.
                diff = evernode.UtilHelpers.getCurrentUnixTime() - startingValidatedTime;
                // Give-up the acquiring process if the instance creation itself takes more than 80% of allowed window(in seconds).
                threshold = this.hostClient.config.leaseAcquireWindow * appenv.ACQUIRE_LEASE_TIMEOUT_THRESHOLD;
                if (diff > threshold) {
                    console.error(`Instance creation timeout. Took: ${diff} seconds. Threshold: ${threshold} seconds`);
                    // Update the lease status of the request to 'SashiTimeout'.
                    await this.updateLeaseStatus(acquireRefId, LeaseStatus.SASHI_TIMEOUT);
                    await this.destroyInstance(createRes.content.name, tenantAddress, leaseIndex, instanceIPv6Address);
                } else {
                    console.log(`Instance created for ${tenantAddress}`);

                    // Save the value to a local variable to prevent the value being updated between two calls ending up with two different values.
                    const currentLedgerIndex = this.lastValidatedLedgerIndex;

                    // Lease created Timestamp
                    const createdTimestamp = evernode.UtilHelpers.getCurrentUnixTime();

                    // Add to in-memory expiry list, so the instance will get destroyed when the moments exceed,
                    this.addToExpiryList(acquireRefId, createRes.content.name, tenantAddress, this.getExpiryTimestamp(createdTimestamp, moments));

                    // Update the database for acquired record.
                    await this.updateAcquiredRecord(acquireRefId, currentLedgerIndex, createdTimestamp);

                    // Update the active instance count.
                    this.activeInstanceCount++;
                    await this.#queueAction(async () => {
                        await this.hostClient.updateRegInfo(this.activeInstanceCount);

                        // Send the acquire response with created instance info.
                        const options = instanceRequirements?.messageKey ? { messageKey: instanceRequirements.messageKey } : {};
                        await this.hostClient.acquireSuccess(acquireRefId, tenantAddress, createRes, options);
                    });
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

            // Re-create the lease offer (Only if the uriToken belongs to this request has a lease index).
            if (leaseIndex >= 0)
                await this.recreateLeaseOffer(uriTokenId, tenantAddress, leaseIndex, instanceIPv6Address).catch(console.error);

            await this.#queueAction(async () => {
                // Send error transaction with received leaseAmount.
                await this.hostClient.acquireError(acquireRefId, tenantAddress, leaseAmount, e.content || 'invalid_acquire_lease').catch(console.error);
            });
        }
        finally {
            await this.#releaseLeaseUpdateLock();
            this.db.close();
        }
    }

    async destroyInstance(containerName, tenantAddress, leaseIndex, ipv6Address = null) {
        // Destroy the instance.
        await this.sashiCli.destroyInstance(containerName);
        await this.recreateLeaseOffer(containerName, tenantAddress, leaseIndex, ipv6Address).catch(console.error);
    }

    async handleExtendLease(r) {

        this.db.open();

        const extendRefId = r.extendRefId;
        const uriTokenId = r.uriTokenId;
        const tenantAddress = r.tenant;
        const amount = r.payment;

        try {

            if (r.transaction.Destination !== this.cfg.xrpl.address)
                throw "Invalid destination";

            const tenantAcc = new evernode.XrplAccount(tenantAddress);
            const hostingToken = (await tenantAcc.getURITokens()).find(n => n.index === uriTokenId && evernode.EvernodeHelpers.isValidURI(n.URI, evernode.EvernodeConstants.LEASE_TOKEN_PREFIX_HEX));

            // Update last watched ledger sequence number.
            await this.updateLastIndexRecord(r.transaction.LedgerIndex);

            if (!hostingToken)
                throw "The URIToken ownership verification was failed in the lease extension process";

            const uriInfo = evernode.UtilHelpers.decodeLeaseTokenUri(hostingToken.URI);
            const leaseAmount = uriInfo.leaseAmount;
            if (leaseAmount <= 0)
                throw "Invalid per moment lease amount";

            const extendingMoments = Math.floor(amount / leaseAmount);

            if (extendingMoments < 1)
                throw "The transaction does not satisfy the minimum extendable moments";

            const instanceSearchCriteria = { tenant_xrp_address: tenantAddress, container_name: hostingToken.index };

            const instance = (await this.getLeaseRecords(instanceSearchCriteria)).find(i => (i.status === LeaseStatus.ACQUIRED || i.status === LeaseStatus.EXTENDED));

            if (!instance)
                throw "No relevant instance was found to perform the lease extension";

            console.log(`Received extend lease from ${tenantAddress}`);

            let expiryItemFound = false;

            let expiryTimeStamp;
            for (const item of this.expiryList) {
                if (item.containerName === instance.container_name) {
                    item.expiryTimestamp = this.getExpiryTimestamp(item.expiryTimestamp, extendingMoments);
                    expiryTimeStamp = item.expiryTimestamp;
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

            const expiryMoment = await this.hostClient.getMoment(expiryTimeStamp)
            await this.#queueAction(async () => {
                // Send the extend success response
                await this.hostClient.extendSuccess(extendRefId, tenantAddress, expiryMoment);
            });

        }
        catch (e) {
            console.error(e);
            await this.#queueAction(async () => {
                // Send the extend error response
                await this.hostClient.extendError(extendRefId, tenantAddress, e.content || 'invalid_extend_lease', amount);
            });
        } finally {
            this.db.close();
        }
    }

    addToExpiryList(txHash, containerName, tenant, expiryTimestamp) {
        this.expiryList.push({
            txHash: txHash,
            containerName: containerName,
            tenant: tenant,
            expiryTimestamp: expiryTimestamp
        });
        console.log(`Container ${containerName} expiry set at ${expiryTimestamp} th timestamp`);
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
        if (this.cfg.networking.ipv6.subnet) {
            await this.createLastAssignedIPEntryIfNotExists();
        }
    }

    async createLastWatchedLedgerEntryIfNotExists() {
        const ret = await this.db.getValues(this.utilTable, { name: appenv.LAST_WATCHED_LEDGER });
        if (ret.length === 0) {
            await this.db.insertValue(this.utilTable, { name: appenv.LAST_WATCHED_LEDGER, value: -1 });
        }
    }

    async createLastAssignedIPEntryIfNotExists() {
        let ret = await this.db.getValues(this.utilTable, { name: appenv.LAST_ASSIGNED_IPV6_ADDRESS });
        if (ret.length === 0) {
            const lastMintedLeaseToken = (await this.hostClient.xrplAcc.getURITokens()).filter(n => evernode.EvernodeHelpers.isValidURI(n.URI, evernode.EvernodeConstants.LEASE_TOKEN_PREFIX_HEX)).sort((a, b) => b.PreviousTxnLgrSeq - a.PreviousTxnLgrSeq)[0];
            const lastMintedLeaseTokenData = evernode.UtilHelpers.decodeLeaseTokenUri(lastMintedLeaseToken.URI);

            await this.db.insertValue(this.utilTable, { name: appenv.LAST_ASSIGNED_IPV6_ADDRESS, value: lastMintedLeaseTokenData.ipv6Address });
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
            timestamp: 0,
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

    async updateAcquiredRecord(txHash, ledgerIndex, timestamp) {
        await this.db.updateValue(this.leaseTable, {
            created_on_ledger: ledgerIndex,
            status: LeaseStatus.ACQUIRED,
            timestamp: timestamp
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

    /**
     * Calculate and return the expiring timestamp from createdTimestamp and momet count
     * @param {*} createdTimestamp Timestamp 
     * @param { integer } moments Lifespan of the instance in moments
     * @returns 
     */
    getExpiryTimestamp(createdTimestamp, moments) {
        return createdTimestamp + moments * this.hostClient.config.momentSize;
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