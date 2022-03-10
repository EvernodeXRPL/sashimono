const fs = require('fs');
const evernode = require('evernode-js-client');
const { SqliteDatabase, DataTypes } = require('./sqlite-handler');
const { appenv } = require('./appenv');
const { SashiCLI } = require('./sashi-cli');

const RedeemStatus = {
    REDEEMING: 'Redeeming',
    REDEEMED: 'Redeemed',
    FAILED: 'Failed',
    EXPIRED: 'Expired',
    SASHI_TIMEOUT: 'SashiTimeout',
}

const TOKEN_RE_ISSUE_THRESHOLD = 0.5; // 50%

class MessageBoard {
    constructor(configPath, dbPath, sashiCliPath) {
        this.configPath = configPath;
        this.redeemTable = appenv.DB_TABLE_NAME;
        this.utilTable = appenv.DB_UTIL_TABLE_NAME;
        this.expiryList = [];
        this.lastHeartbeatMoment = null;

        if (!fs.existsSync(sashiCliPath))
            throw `Sashi CLI does not exist in ${sashiCliPath}.`;

        this.sashiCli = new SashiCLI(sashiCliPath);
        this.db = new SqliteDatabase(dbPath);
    }

    async init() {
        if (!fs.existsSync(this.configPath))
            throw `${this.configPath} does not exist.`;

        this.readConfig();
        if (!this.cfg.version || !this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.token || !this.cfg.xrpl.registryAddress || !this.cfg.dex.listingLimit)
            throw "Required cfg fields cannot be empty.";

        if (appenv.IS_TARGET_USER_DEFINED && !this.cfg.dex.targetPrice)
            throw "Target price is required in cfg in user target price mode.";

        console.log("Using registry " + this.cfg.xrpl.registryAddress);

        this.xrplApi = new evernode.XrplApi();
        evernode.Defaults.set({
            registryAddress: this.cfg.xrpl.registryAddress,
            xrplApi: this.xrplApi
        })
        await this.xrplApi.connect();

        this.hostClient = new evernode.HostClient(this.cfg.xrpl.address, this.cfg.xrpl.secret);
        await this.hostClient.connect();
        this.targetPrice = appenv.IS_TARGET_USER_DEFINED ? this.cfg.dex.targetPrice : this.hostClient.config.momentCommunityPrice; // in EVRs.

        this.db.open();
        // Create redeem table if not exist.
        await this.createRedeemTableIfNotExists();
        await this.createUtilDataTableIfNotExists();

        this.lastValidatedLedgerIndex = this.xrplApi.ledgerIndex;

        const redeems = await this.getRedeemedRecords();
        for (const redeem of redeems)
            this.addToExpiryList(redeem.tx_hash, redeem.container_name, await this.getExpiryMoment(redeem.created_on_ledger, redeem.h_token_amount));

        this.db.close();

        // Denote that there is an ongoing trading operation.
        let operationOngoing = false;
        let ongoingMoment = null;
        // Check for instance expiry.
        this.xrplApi.on(evernode.XrplApiEvents.LEDGER, async (e) => {
            this.lastValidatedLedgerIndex = e.ledger_index;

            const currentMoment = await this.hostClient.getMoment(e.ledger_index);

            // Check trading offer status (available balance amount and target price) every moment.
            if (!ongoingMoment || ongoingMoment !== currentMoment) {
                ongoingMoment = currentMoment;
                if (!operationOngoing) {
                    operationOngoing = true;
                    try {
                        const tokenOffer = await this.hostClient.getTokenOffer();
                        let re_issue_target_change = false;
                        if (!appenv.IS_TARGET_USER_DEFINED)
                            // Refresh the evernode configs to get the latest target price set by purchaser community contract.
                            await this.hostClient.refreshConfig();

                        if (!appenv.IS_TARGET_USER_DEFINED && this.targetPrice !== this.hostClient.config.momentCommunityPrice)
                            this.targetPrice = this.hostClient.config.momentCommunityPrice;

                        if (tokenOffer && tokenOffer.quality !== this.targetPrice) {
                            console.log('Target price has changed since last offer.');
                            re_issue_target_change = true;
                        }
                        if (re_issue_target_change || !tokenOffer || tokenOffer.taker_gets.value <= this.cfg.dex.listingLimit * TOKEN_RE_ISSUE_THRESHOLD) {

                            console.log(`Balance ${tokenOffer?.taker_gets?.value}. Threshold: ${this.cfg.dex.listingLimit * TOKEN_RE_ISSUE_THRESHOLD}`);
                            if (tokenOffer) {
                                console.log(`Cancelling the previous offer. Seq: ${tokenOffer?.seq}`)
                                await this.hostClient.cancelOffer(tokenOffer?.seq);
                            }
                            console.log(`Creating a new offer with target price ${this.targetPrice} for ${this.cfg.dex.listingLimit} ${this.cfg.xrpl.token}s.`);
                            await this.hostClient.createTokenSellOffer(this.cfg.dex.listingLimit, (this.cfg.dex.listingLimit * this.targetPrice).toString());
                        }
                    } catch (error) {
                        console.error(error);
                    }
                    operationOngoing = false;
                }
            }

            // Sending heartbeat every CONF_HOST_HEARTBEAT_FREQ moments.
            if (currentMoment % this.hostClient.config.hostHeartbeatFreq === 0 && currentMoment !== this.lastHeartbeatMoment) {
                this.lastHeartbeatMoment = currentMoment;

                console.log(`Reporting heartbeat at Moment ${this.lastHeartbeatMoment}...`)

                try {
                    // await this.hostClient.heartbeat();
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
                        await this.updateRedeemStatus(x.txHash, RedeemStatus.EXPIRED);
                        console.log(`Destroyed ${x.containerName}`);
                    }
                    catch (e) {
                        console.error(e);
                    }
                }
                this.db.close();
            }
        });

        this.hostClient.on(evernode.HostEvents.Redeem, r => this.handleRedeem(r));
    }

    async handleRedeem(r) {

        if (r.token !== this.cfg.xrpl.token || r.host !== this.cfg.xrpl.address)
            return;

        this.db.open();

        // Update last watched ledger sequence number.
        await this.updateLastIndexRecord(r.transaction.LastLedgerSequence);

        const redeemRefId = r.redeemRefId; // Redeem tx hash.
        const userAddress = r.user;
        const amount = r.moments;

        try {
            console.log(`Received redeem from ${userAddress}`);
            await this.createRedeemRecord(redeemRefId, userAddress, amount);

            // The last validated ledger when we receive the redeem request.
            const startingValidatedLedger = this.lastValidatedLedgerIndex;

            // Wait until the sashi cli is available.
            await this.sashiCli.wait();

            // Number of validated ledgers passed while processing the last request.
            let diff = this.lastValidatedLedgerIndex - startingValidatedLedger;
            // Give-up the redeeming porocess if processing the last request takes more than 40% of allowed window.
            let threshold = this.hostClient.config.redeemWindow * appenv.REDEEM_WAIT_TIMEOUT_THRESHOLD;
            if (diff > threshold) {
                console.error(`Sashimono busy timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                // Update the redeem status of the request to 'SashiTimeout'.
                await this.updateRedeemStatus(redeemRefId, RedeemStatus.SASHI_TIMEOUT);
            }
            else {
                const instanceRequirements = r.payload;
                const createRes = await this.sashiCli.createInstance(instanceRequirements);

                // Number of validated ledgers passed while the instance is created.
                diff = this.lastValidatedLedgerIndex - startingValidatedLedger;
                // Give-up the redeeming porocess if the instance creation itself takes more than 80% of allowed window.
                threshold = this.hostClient.config.redeemWindow * appenv.REDEEM_CREATE_TIMEOUT_THRESHOLD;
                if (diff > threshold) {
                    console.error(`Instance creation timeout. Took: ${diff} ledgers. Threshold: ${threshold}`);
                    // Update the redeem status of the request to 'SashiTimeout'.
                    await this.updateRedeemStatus(redeemRefId, RedeemStatus.SASHI_TIMEOUT);
                    // Destroy the instance.
                    await this.sashiCli.destroyInstance(createRes.content.name);
                } else {
                    console.log(`Instance created for ${userAddress}`);

                    // Save the value to a local variable to prevent the value being updated between two calls ending up with two different values.
                    const currentLedgerIndex = this.lastValidatedLedgerIndex;

                    // Add to in-memory expiry list, so the instance will get destroyed when the moments exceed,
                    this.addToExpiryList(redeemRefId, createRes.content.name, await this.getExpiryMoment(currentLedgerIndex, amount));

                    // Update the database for redeemed record.
                    await this.updateRedeemedRecord(redeemRefId, createRes.content.name, currentLedgerIndex);

                    // Send the redeem response with created instance info.
                    await this.hostClient.redeemSuccess(redeemRefId, userAddress, createRes);
                }
            }
        }
        catch (e) {
            console.error(e);

            // Update the redeem response for failures.
            await this.updateRedeemStatus(redeemRefId, RedeemStatus.FAILED);

            await this.hostClient.redeemError(redeemRefId, e.content);
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

    async createRedeemTableIfNotExists() {
        // Create table if not exists.
        await this.db.createTableIfNotExists(this.redeemTable, [
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

    async getRedeemedRecords() {
        return (await this.db.getValues(this.redeemTable, { status: RedeemStatus.REDEEMED }));
    }

    async createRedeemRecord(txHash, txUserAddress, txAmount) {
        await this.db.insertValue(this.redeemTable, {
            timestamp: Date.now(),
            tx_hash: txHash,
            user_xrp_address: txUserAddress,
            h_token_amount: txAmount,
            status: RedeemStatus.REDEEMING
        });
    }

    async updateLastIndexRecord(ledger_idx) {
        await this.db.updateValue(this.utilTable, {
            value: ledger_idx,
        }, { name: appenv.LAST_WATCHED_LEDGER });
    }

    async updateRedeemedRecord(txHash, containerName, ledgerIndex) {
        await this.db.updateValue(this.redeemTable, {
            container_name: containerName,
            created_on_ledger: ledgerIndex,
            status: RedeemStatus.REDEEMED
        }, { tx_hash: txHash });
    }

    async updateRedeemStatus(txHash, status) {
        await this.db.updateValue(this.redeemTable, { status: status }, { tx_hash: txHash });
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