const fs = require('fs');
const evernode = require('evernode-js-client');
const { SqliteDatabase, DataTypes } = require('./sqlite-handler');
const { appenv } = require('./appenv');
const { SashiCLI } = require('./sashi-cli');
const { Utility } = require('./utility');

const LeaseStatus = {
    ACQUIRING: 'Acquiring',
    ACQUIRED: 'Acquired',
    FAILED: 'Failed',
    EXPIRED: 'Expired',
    SASHI_TIMEOUT: 'SashiTimeout',
}

const TOKEN_RE_ISSUE_THRESHOLD = 0.5; // 50%
const TRADING_INTERVAL = 50;

class MessageBoard {
    constructor(configPath, dbPath, sashiCliPath) {
        this.configPath = configPath;
        this.leaseTable = appenv.DB_TABLE_NAME;
        this.utilTable = appenv.DB_UTIL_TABLE_NAME;
        this.expiryList = [];

        if (!fs.existsSync(sashiCliPath))
            throw `Sashi CLI does not exist in ${sashiCliPath}.`;

        this.sashiCli = new SashiCLI(sashiCliPath);
        this.db = new SqliteDatabase(dbPath);
    }

    async init() {
        if (!fs.existsSync(this.configPath))
            throw `${this.configPath} does not exist.`;

        this.readConfig();
        if (!this.cfg.version || !this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.registryAddress)
            throw "Required cfg fields cannot be empty.";

        if (this.cfg.xrpl.leaseAmount && this.cfg.xrpl.leaseAmount === 'string') {
            try {
                this.cfg.xrpl.leaseAmount = parseInt(this.cfg.xrpl.leaseAmount);
            }
            catch {
                throw "Lease amount should be a numerical value.";
            }
        }

        if (this.cfg.xrpl.leaseAmount && this.cfg.xrpl.leaseAmount < 0)
            throw "Lease amount should be a positive intiger.";

        console.log("Using registry " + this.cfg.xrpl.registryAddress);

        this.xrplApi = new evernode.XrplApi();
        evernode.Defaults.set({
            registryAddress: this.cfg.xrpl.registryAddress,
            xrplApi: this.xrplApi
        })
        await this.xrplApi.connect();

        this.hostClient = new evernode.HostClient(this.cfg.xrpl.address, this.cfg.xrpl.secret);
        await this.hostClient.connect();
        this.leaseAmount = this.cfg.xrpl.leaseAmount ? this.cfg.xrpl.leaseAmount : this.hostClient.config.purchaserTargetPrice; // in EVRs.

        // Get last heartbeat moment from the host info.
        const hostInfo = await this.hostClient.getRegistration();
        // Get moment only if heartbeat info is not 0.
        this.lastHeartbeatMoment = hostInfo.lastHeartbeatLedger ? await this.hostClient.getMoment(hostInfo.lastHeartbeatLedger) : 0;

        this.db.open();
        // Create lease table if not exist.
        await this.createLeaseTableIfNotExists();
        await this.createUtilDataTableIfNotExists();

        this.lastValidatedLedgerIndex = this.xrplApi.ledgerIndex;

        const leaseRecords = await this.getAcquiredRecords();
        for (const lease of leaseRecords)
            this.addToExpiryList(lease.tx_hash, lease.container_name, await this.getExpiryMoment(lease.created_on_ledger, lease.h_token_amount));

        this.db.close();

        // Denote that there is an ongoing trading operation.
        let tradingOperationOngoing = false;
        // Check for instance expiry.
        this.xrplApi.on(evernode.XrplApiEvents.LEDGER, async (e) => {
            this.lastValidatedLedgerIndex = e.ledger_index;

            const currentMoment = await this.hostClient.getMoment(e.ledger_index);

            // Check trading offer status (available balance amount and token price) after every TRADING_INTERVAL ledgers.
            // if (e.ledger_index % TRADING_INTERVAL == 0) {
            //     if (!tradingOperationOngoing) {
            //         tradingOperationOngoing = true;
            //         try {
            //             const tokenOffer = await this.hostClient.getTokenOffer();
            //             let re_issue_price_change = false;
            //             if (!this.cfg.dex.tokenPrice || this.cfg.dex.tokenPrice === "0")
            //                 // Refresh the evernode configs to get the latest target price set by purchaser community contract.
            //                 await this.hostClient.refreshConfig();

            //             if ((!this.cfg.dex.tokenPrice || this.cfg.dex.tokenPrice === "0") && this.tokenPrice !== this.hostClient.config.purchaserTargetPrice)
            //                 this.tokenPrice = this.hostClient.config.purchaserTargetPrice;

            //             if (tokenOffer && tokenOffer.quality !== this.tokenPrice) {
            //                 console.log('Token price has changed since last offer.');
            //                 re_issue_price_change = true;
            //             }
            //             if (re_issue_price_change || !tokenOffer || tokenOffer.taker_gets.value <= this.cfg.dex.listingLimit * TOKEN_RE_ISSUE_THRESHOLD) {

            //                 console.log(`Balance ${tokenOffer?.taker_gets?.value || 0}. Threshold: ${this.cfg.dex.listingLimit * TOKEN_RE_ISSUE_THRESHOLD}`);
            //                 if (tokenOffer) {
            //                     console.log(`Cancelling the previous offer. Seq: ${tokenOffer?.seq}`)
            //                     await this.hostClient.cancelOffer(tokenOffer?.seq);
            //                 }
            //                 console.log(`Creating a new offer with token price ${this.tokenPrice} for ${this.cfg.dex.listingLimit} ${this.cfg.xrpl.token}s.`);
            //                 await this.hostClient.createTokenSellOffer(this.cfg.dex.listingLimit, (this.cfg.dex.listingLimit * this.tokenPrice).toString());
            //             }
            //         } catch (error) {
            //             console.error(error);
            //         }
            //         tradingOperationOngoing = false;
            //     }
            // }

            // Sending heartbeat every CONF_HOST_HEARTBEAT_FREQ moments.
            if (currentMoment % this.hostClient.config.hostHeartbeatFreq === 0 && currentMoment !== this.lastHeartbeatMoment) {
                this.lastHeartbeatMoment = currentMoment;

                console.log(`Reporting heartbeat at Moment ${this.lastHeartbeatMoment}...`)

                try {
                    await this.hostClient.heartbeat();
                    console.log(`Heartbeat reported at Moment ${this.lastHeartbeatMoment}.`);
                }
                catch (err) {
                    if (err.code === 'tecHOOK_REJECTED')
                        console.log("Heartbeat rejected by the hook.");
                    else
                        console.log("Heartbeat tx error", err);
                }
            }

            // Filter out instances which needed to be expired and destroy them.
            const expired = this.expiryList.filter(x => x.expiryMoment < currentMoment);
            if (expired && expired.length) {
                this.expiryList = this.expiryList.filter(x => x.expiryMoment >= currentMoment);

                this.db.open();
                for (const x of expired) {
                    try {
                        console.log(`Moments exceeded (current:${currentMoment}, expiry:${x.expiryMoment}). Destroying ${x.containerName}`);
                        await this.sashiCli.destroyInstance(x.containerName);
                        await this.updateLeaseStatus(x.txHash, LeaseStatus.EXPIRED);
                        console.log(`Destroyed ${x.containerName}`);
                    }
                    catch (e) {
                        console.error(e);
                    }
                }
                this.db.close();
            }
        });

        this.hostClient.on(evernode.HostEvents.AcquireLease, r => this.handleAcquire(r));
    }

    async handleAcquire(r) {

        if (r.host !== this.cfg.xrpl.address)
            return;

        this.db.open();

        // Update last watched ledger sequence number.
        await this.updateLastIndexRecord(r.transaction.LastLedgerSequence);

        const acquireRefId = r.acquireRefId; // Acquire tx hash.
        const tenantAddress = r.tenant;
        // Since acquire is accepted for leaseAmount
        const moments = 1;

        try {
            console.log(`Received acquire lease from ${tenantAddress}`);
            await this.createLeaseRecord(acquireRefId, tenantAddress, moments);

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
            }
            else {
                const instanceRequirements = r.payload;
                const createRes = await this.sashiCli.createInstance(instanceRequirements);

                // Number of validated ledgers passed while the instance is created.
                diff = this.lastValidatedLedgerIndex - startingValidatedLedger;
                // Give-up the acquiringing porocess if the instance creation itself takes more than 80% of allowed window.
                threshold = this.hostClient.config.leaseAcquireWindow * appenv.ACQUIRE_LEASE_TIMEOUT_THRESHOLD;
                if (diff > threshold) {
                    console.error(`Instance creation timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                    // Update the lease status of the request to 'SashiTimeout'.
                    await this.updateLeaseStatus(acquireRefId, LeaseStatus.SASHI_TIMEOUT);
                    // Destroy the instance.
                    await this.sashiCli.destroyInstance(createRes.content.name);
                } else {
                    console.log(`Instance created for ${tenantAddress}`);

                    // Save the value to a local variable to prevent the value being updated between two calls ending up with two different values.
                    const currentLedgerIndex = this.lastValidatedLedgerIndex;

                    // Add to in-memory expiry list, so the instance will get destroyed when the moments exceed,
                    this.addToExpiryList(acquireRefId, createRes.content.name, await this.getExpiryMoment(currentLedgerIndex, moments));

                    // Update the database for acquired record.
                    await this.updateAcquiredRecord(acquireRefId, createRes.content.name, currentLedgerIndex);

                    // Send the acquire response with created instance info.
                    await this.hostClient.acquireSuccess(acquireRefId, tenantAddress, createRes);
                }
            }
        }
        catch (e) {
            console.error(e);

            // Update the lease response for failures.
            await this.updateLeaseStatus(acquireRefId, LeaseStatus.FAILED);

            // Burn the NFTs and recreate the offer abd send back the lease amount back to the user.
            await this.hostClient.burnOfferLease(r.nfTokenId);

            await this.hostClient.createOfferLease(r.leaseAmount, Utility.getTOSHash());

            // Send error transaction with received leaseAmount.
            await this.hostClient.acquireError(acquireRefId, tenantAddress, r.leaseAmount, e.content);
        }

        this.db.close();
    }

    addToExpiryList(txHash, containerName, expiryMoment) {
        this.expiryList.push({
            txHash: txHash,
            containerName: containerName,
            expiryMoment: expiryMoment,
        });
        console.log(`Container ${containerName} expiry set at ${expiryMoment}`);
    }

    async createLeaseTableIfNotExists() {
        // Create table if not exists.
        await this.db.createTableIfNotExists(this.leaseTable, [
            { name: 'timestamp', type: DataTypes.INTEGER, notNull: true },
            { name: 'tx_hash', type: DataTypes.TEXT, primary: true, notNull: true },
            { name: 'user_xrp_address', type: DataTypes.TEXT, notNull: true },
            { name: 'h_token_amount', type: DataTypes.INTEGER, notNull: true },
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

    async createLeaseRecord(txHash, txUserAddress, moments) {
        await this.db.insertValue(this.leaseTable, {
            timestamp: Date.now(),
            tx_hash: txHash,
            user_xrp_address: txUserAddress,
            h_token_amount: moments,
            status: LeaseStatus.ACQUIRING
        });
    }

    async updateLastIndexRecord(ledger_idx) {
        await this.db.updateValue(this.utilTable, {
            value: ledger_idx,
        }, { name: appenv.LAST_WATCHED_LEDGER });
    }

    async updateAcquiredRecord(txHash, containerName, ledgerIndex) {
        await this.db.updateValue(this.leaseTable, {
            container_name: containerName,
            created_on_ledger: ledgerIndex,
            status: LeaseStatus.ACQUIRED
        }, { tx_hash: txHash });
    }

    async updateLeaseStatus(txHash, status) {
        await this.db.updateValue(this.leaseTable, { status: status }, { tx_hash: txHash });
    }

    async getExpiryMoment(createdOnLedger, moments) {
        return (await this.hostClient.getMoment(createdOnLedger)) + moments;
    }

    readConfig() {
        this.cfg = JSON.parse(fs.readFileSync(this.configPath).toString());
    }

    persistConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
    }
}

module.exports = {
    MessageBoard
}