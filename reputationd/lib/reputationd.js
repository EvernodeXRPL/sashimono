const fs = require('fs');
const evernode = require('evernode-js-client');
const crypto = require('crypto');
const uuid = require('uuid');
const path = require('path');
const { appenv } = require('./appenv');
const { ConfigHelper } = require('./config-helper');
const { ContractHelper, CommonHelper } = require('./util-helper');
const { ContractInstanceManager, INPUT_PROTOCOLS } = require('./contract-instance-manager');

const ContractStatus = {
    Created: 1,
    Updated: 2,
    Deployed: 3
}

class ReputationD {
    #concurrencyQueue = {
        processing: false,
        queue: []
    };
    #applyFeeUpliftment = false;
    #reputationRetryDelay = 300000; // 5 mins
    #reputationRetryCount = 3;
    #feeUpliftment = 0;
    #preparationTimeQuota = 0.9; // Percentage of moment size.
    #reputationSendTimeSlice = 0.35; // Slice of preparationTimeQuota for reputation registration.
    #deploymentStartTimeQuota = 0.75;
    #universeSize = 64;
    #readScoreCmd = 'read_scores';

    #configPath;
    #mbXrplConfigPath;
    #instanceImage;
    #contractPath;

    constructor(configPath, mbXrplConfigPath, instanceImage, contractPath) {
        this.#configPath = configPath;
        this.#mbXrplConfigPath = mbXrplConfigPath;
        this.#instanceImage = instanceImage;
        this.#contractPath = contractPath;
    }

    async init() {
        this.#readConfig();
        if (!this.cfg.version || !this.cfg.xrpl.address || !this.cfg.xrpl.secret)
            throw "Required cfg fields cannot be empty.";

        await evernode.Defaults.useNetwork(this.cfg.xrpl.network || appenv.NETWORK);

        if (this.cfg.xrpl.governorAddress)
            evernode.Defaults.set({
                governorAddress: this.cfg.xrpl.governorAddress
            });

        if (this.cfg.xrpl.rippledServer)
            evernode.Defaults.set({
                rippledServer: this.cfg.xrpl.rippledServer
            });

        if (this.cfg.xrpl.fallbackRippledServers && this.cfg.xrpl.fallbackRippledServers.length)
            evernode.Defaults.set({
                fallbackRippledServers: this.cfg.xrpl.fallbackRippledServers
            });

        this.xrplApi = new evernode.XrplApi();
        evernode.Defaults.set({
            xrplApi: this.xrplApi
        })
        await this.xrplApi.connect();

        this.hostClient = new evernode.HostClient(this.cfg.xrpl.hostAddress, this.cfg.xrpl.hostSecret);
        await this.#connectHost();

        console.log("Using,");
        console.log("\tGovernor account " + this.cfg.xrpl.governorAddress);
        console.log("\tReputation account " + this.hostClient.config.reputationAddress);
        console.log("Using xahaud " + this.cfg.xrpl.rippledServer);

        // Get last heartbeat moment from the host info.
        let hostInfo = await this.hostClient.getRegistration();
        if (!hostInfo)
            throw "Host is not registered.";

        this.reputationClient = await evernode.HookClientFactory.create(evernode.HookTypes.reputation);

        await this.#connectReputation();

        const repInfo = await this.hostClient.getReputationInfo();
        // Last registered moment n means reputation is sent in n-1 moment.
        this.lastReputationMoment = repInfo ? (repInfo.lastRegisteredMoment - 1) : 0;

        this.xrplApi.on(evernode.XrplApiEvents.DISCONNECTED, async (e) => {
            console.log(`Exiting due to server disconnect (code ${e})...`);
            process.exit(1);
        });


        this.xrplApi.on(evernode.XrplApiEvents.SERVER_DESYNCED, async (e) => {
            console.log(`Exiting due to server desync condition...`);
            process.exit(1);
        });

        this.xrplApi.on(evernode.XrplApiEvents.LEDGER, async (e) => {
            this.lastValidatedLedgerIndex = e.ledger_index;
            this.lastLedgerTime = evernode.UtilHelpers.getCurrentUnixTime('milli');
        });

        // Start queue processor job.
        this.#startReputationClockScheduler();

        // Schedule reputation jobs.
        this.#startReputationSendScheduler();

        // Schedule reputation contract jobs.
        this.#startReputationContractScheduler();
    }

    #prepareHostClientFunctionOptions() {
        let options = {}
        if (this.#applyFeeUpliftment) {
            options.transactionOptions = { feeUplift: this.#feeUpliftment }
        }

        return options;
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

    async #queueAction(action, maxAttempts = 5, delay = 0) {
        await this.#acquireConcurrencyQueue();

        this.#concurrencyQueue.queue.push({
            callback: action,
            submissionRefs: {},
            attempts: 0,
            maxAttempts: maxAttempts,
            delay: delay
        });

        await this.#releaseConcurrencyQueue();
    }

    async #processConcurrencyQueue() {
        await this.#acquireConcurrencyQueue();

        let toKeep = [];
        for (let action of this.#concurrencyQueue.queue) {
            try {
                await action.callback(action.submissionRefs);
                this.#applyFeeUpliftment = false;
                this.#feeUpliftment = 0;
            }
            catch (e) {
                if (action.attempts < action.maxAttempts) {
                    action.attempts++;
                    if (this.cfg.xrpl.affordableExtraFee > 0 && e.status === "TOOK_LONG") {
                        this.#applyFeeUpliftment = true;
                        this.#feeUpliftment = Math.floor((this.cfg.xrpl.affordableExtraFee * action.attempts) / action.maxAttempts);
                    }
                    if (action.delay > 0) {
                        new Promise((resolve) => {
                            const checkFlagInterval = setInterval(() => {
                                if (!this.#concurrencyQueue.processing) {
                                    this.#concurrencyQueue.queue.push(action);
                                    clearInterval(checkFlagInterval);
                                    resolve();
                                }
                            }, action.delay);
                        });
                    } else
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

    // Connect the host and trying to reconnect in the event of account not found error.
    // Account not found error can be because of a network reset. (Dev and test nets)
    async #connect(client, options = null) {
        let attempts = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                attempts++;
                const ret = options ? await client.connect(options) : await client.connect();
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
        await this.#connect(this.hostClient, { reputationAddress: this.cfg.xrpl.address, reputationSecret: this.cfg.xrpl.secret });
    }

    async #connectReputation() {
        await this.#connect(this.reputationClient);
    }

    async #startReputationClockScheduler() {
        const timeout = appenv.REPUTATIOND_SCHEDULER_INTERVAL_SECONDS * 1000; // Seconds to millisecs.

        const scheduler = async () => {
            await this.#processConcurrencyQueue();
            setTimeout(async () => {
                await scheduler();
            }, timeout);
        };

        setTimeout(async () => {
            await scheduler();
        }, timeout);
    }

    async #startReputationSendScheduler() {
        const momentSize = this.hostClient.config.momentSize;

        const timeout = momentSize * 1000; // Converting seconds to milliseconds.

        const scheduler = async () => {
            setTimeout(async () => {
                await scheduler();
            }, timeout);
            await this.#sendReputations();
        };

        let startTimeout = 0;
        const momentStartTimestamp = await this.hostClient.getMomentStartIndex();
        const currentTimestamp = evernode.UtilHelpers.getCurrentUnixTime();
        const currentMoment = await this.hostClient.getMoment();

        // Set time relative to current passed time.
        const timeQuota = momentSize * (1 - this.#preparationTimeQuota);
        const upperBound = Math.floor(momentStartTimestamp + momentSize - (timeQuota * (1 - this.#reputationSendTimeSlice)));
        const lowerBound = Math.floor(momentStartTimestamp + momentSize - timeQuota);
        if (currentTimestamp < lowerBound || currentTimestamp >= upperBound)
            startTimeout = Math.floor(lowerBound + (Math.random() * ((upperBound - lowerBound) / 2)) - currentTimestamp) * 1000 // Converting seconds to milliseconds.

        // If already registered for this moment, Schedule for next moment.
        if (startTimeout < 0 || this.lastReputationMoment === currentMoment)
            startTimeout += (momentSize * 1000);

        console.log(`Reputation sender scheduled to start in ${startTimeout} milliseconds.`);

        setTimeout(async () => {
            await scheduler();
        }, startTimeout);
    }

    async #startReputationContractScheduler() {
        const momentSize = this.hostClient.config.momentSize;

        const timeout = momentSize * 1000; // Converting seconds to milliseconds.

        const scheduler = async () => {
            setTimeout(async () => {
                await scheduler();
            }, timeout);
            await this.#createReputationContract();
        };

        let startTimeout = 0;
        const momentStartTimestamp = await this.hostClient.getMomentStartIndex();
        const currentTimestamp = evernode.UtilHelpers.getCurrentUnixTime();
        const currentMoment = await this.hostClient.getMoment();

        const timeQuota = momentSize * (1 - this.#preparationTimeQuota);
        const upperBound = Math.floor(momentStartTimestamp + momentSize);
        const lowerBound = Math.floor(momentStartTimestamp + momentSize - (timeQuota * (1 - this.#reputationSendTimeSlice)));

        if (currentTimestamp < lowerBound)
            startTimeout = Math.floor(lowerBound + (Math.random() * ((upperBound - lowerBound) / 2)) - currentTimestamp) * 1000 // Converting seconds to milliseconds.

        // If not registered for next moment, Schedule for next moment.
        if (startTimeout === 0 && this.lastReputationMoment !== currentMoment)
            startTimeout += (momentSize * 1000);

        console.log(`Reputation contract creation scheduled to start in ${startTimeout} milliseconds.`);

        setTimeout(async () => {
            await scheduler();
        }, startTimeout);
    }

    async #getUniverseInfo(moment) {
        const repInfo = await this.hostClient.getReputationInfo(moment);

        if (!repInfo || !('orderedId' in repInfo))
            return null;

        return {
            index: Math.floor(repInfo.orderedId / this.#universeSize)
        };
    }

    async #getInstancesInUniverse(universeIndex, moment) {
        const minOrderedId = universeIndex * this.#universeSize;
        return (await Promise.all(Array.from({ length: this.#universeSize }, (_, i) => i + minOrderedId).map(async (orderedId) => {
            const repInfo = await this.reputationClient.getReputationInfoByOrderedId(orderedId, moment);
            if (!repInfo)
                return null;

            return repInfo.contract;
        }))).filter(i => i);
    }

    // Find the universe id and generate contract id.
    #generateContractId(universeIndex) {
        const buf = Buffer.alloc(4, 0);
        buf.writeUint32LE(universeIndex);

        // Generate a hash from the seed
        const hash = crypto.createHash('sha1').update(buf.toString('hex')).digest('hex');
        // Use a portion of the hash to generate a random UUID
        const id = uuid.v4({
            random: Buffer.from(hash, 'hex')
        });

        return id;
    }

    async #deployContract(instanceIp, instanceUserPort, userPrivateKey, hpOverrideCfg) {
        const bundlePath = await ContractHelper.prepareContractBundle(this.#contractPath, hpOverrideCfg);
        console.log(`Prepared contract bundle at ${bundlePath}`);

        let instanceMgr;
        try {
            instanceMgr = new ContractInstanceManager({
                ip: instanceIp,
                userPort: instanceUserPort,
                userPrivateKey: userPrivateKey
            });

            await instanceMgr.init();
            await instanceMgr.uploadBundle(bundlePath);

            fs.rmSync(path.dirname(bundlePath), { recursive: true, force: true });
            if (instanceMgr)
                await instanceMgr.terminate();
            console.log(`Contract bundle uploaded!`);
        } catch (e) {
            fs.rmSync(path.dirname(bundlePath), { recursive: true, force: true });
            if (instanceMgr)
                await instanceMgr.terminate();
            throw e;
        }
    }

    // Create and setup reputation contract.
    async #createReputationContract() {
        const scheduledMoment = await this.hostClient.getMoment();

        await this.#queueAction(async (submissionRefs) => {
            const curMoment = await this.reputationClient.getMoment();

            const universeInfo = await this.#getUniverseInfo(curMoment + 1);

            if (!universeInfo) {
                console.log(`Skipping reputation contract preparation since there's no universe info for the moment ${curMoment + 1}.`);
                return;
            }

            if (scheduledMoment != curMoment) {
                console.log(`Skipping since scheduled moment has passed. Scheduled in ${scheduledMoment}, Current moment ${curMoment}.`);
                return;
            }
            else if (this.lastReputationMoment !== curMoment) {
                console.log(`Skipping reputation contract preparation since not registered for the moment ${curMoment + 1}.`);
                return;
            }

            console.log(`Preparing reputation contract for the Moment ${curMoment + 1}...`);

            if (!this.cfg.contractInstance || !this.cfg.contractInstance.created_timestamp ||
                curMoment > (await this.reputationClient.getMoment(this.cfg.contractInstance.created_timestamp))) {
                submissionRefs.refs ??= [{}];
                // Check again wether the transaction is validated before retry.
                const txHash = submissionRefs?.refs[0]?.submissionResult?.result?.tx_json?.hash;
                if (txHash) {
                    const txResponse = await tenantClient.xrplApi.getTransactionValidatedResults(txHash);
                    if (txResponse && txResponse.code === "tesSUCCESS") {
                        console.log('Transaction is validated and success, Retry skipped!')
                        return;
                    }
                }

                const tenantClient = new evernode.TenantClient(this.hostClient.reputationAcc.address, this.hostClient.reputationAcc.secret, { messagePrivateKey: this.hostClient.accKeyPair.privateKey });
                await tenantClient.connect();
                await tenantClient.prepareAccount();

                const ownerKeys = await CommonHelper.generateKeys();

                const requirement = {
                    owner_pubkey: ownerKeys.publicKey,
                    contract_id: this.#generateContractId(universeInfo.index),
                    image: this.#instanceImage,
                    config: {
                        contract: {
                            consensus: {
                                roundtime: 5000
                            }
                        }
                    }
                };

                console.log(`Acquiring the reputation contract instance.`);

                // Update the registry with the active instance count.
                const result = await tenantClient.acquireLease(this.hostClient.xrplAcc.address, requirement, { submissionRef: submissionRefs?.refs[0], ...this.#prepareHostClientFunctionOptions() });

                await tenantClient.disconnect();

                const acquiredTimestamp = Date.now();

                // Assign ip to domain and outbound_ip for instance created from old sashimono version.
                if ('ip' in result.instance) {
                    result.instance.domain = result.instance.ip;
                    delete result.instance.ip;
                }

                console.log('Reputation contract created in instance', result.instance);

                this.cfg.contractInstance = {
                    ...result.instance,
                    created_timestamp: Math.floor(acquiredTimestamp / 1000), // Convert to seconds
                    owner_privatekey: ownerKeys.privateKey,
                    status: ContractStatus.Created
                };
                this.#persistConfig();
            }
            else {
                console.log(`Skipping acquire since there is already created instance for the moment ${curMoment + 1}.`)
            }

            if (this.cfg.contractInstance && this.cfg.contractInstance.created_timestamp &&
                curMoment === (await this.reputationClient.getMoment(this.cfg.contractInstance.created_timestamp))) {

                if (this.cfg.contractInstance.status === ContractStatus.Created) {
                    // Set reputation contract info in domain.
                    console.log(`Updating host reputation domain info.`);
                    await this.hostClient.setReputationContractInfo(this.cfg.contractInstance.peer_port, this.cfg.contractInstance.pubkey);
                    console.log(`Updated host reputation domain info.`);

                    // Mark as updated.
                    this.cfg.contractInstance.status = ContractStatus.Updated;
                    this.#persistConfig();

                    // Wait for some time to let others to prepare.
                    const momentSize = this.hostClient.config.momentSize;
                    const momentStartTimestamp = await this.hostClient.getMomentStartIndex();
                    const currentTimestamp = evernode.UtilHelpers.getCurrentUnixTime();

                    const timeQuota = momentSize * (1 - this.#preparationTimeQuota);
                    const upperBound = Math.floor(momentStartTimestamp + momentSize);
                    const lowerBound = Math.floor(momentStartTimestamp + momentSize - (timeQuota * (1 - this.#reputationSendTimeSlice)));
                    const startTimestamp = lowerBound + ((upperBound - lowerBound) * this.#deploymentStartTimeQuota);

                    let startTimeout = 0;
                    if (startTimestamp > currentTimestamp)
                        startTimeout = (startTimestamp - currentTimestamp) * 1000;

                    console.log(`Waiting ${startTimeout} until other hosts are ready.`);
                    await new Promise((resolve) => setTimeout(resolve, startTimeout));
                }

                if (this.cfg.contractInstance.status === ContractStatus.Updated) {
                    const instances = await this.#getInstancesInUniverse(universeInfo.index, curMoment + 1);
                    const overrideConfig = {
                        unl: instances.map(p => `${p.pubkey}`),
                        contract: {
                            bin_path: '/usr/bin/node',
                            bin_args: 'index.js',
                            consensus: {
                                roundtime: 2000
                            }
                        },
                        mesh: {
                            known_peers: instances.map(p => `${p.domain}:${p.peerPort}`)
                        }
                    };

                    console.log(`Deploying the reputation contract instance.`);
                    await this.#deployContract(this.cfg.contractInstance.domain, this.cfg.contractInstance.user_port, this.cfg.contractInstance.owner_privatekey, overrideConfig);
                    console.log(`Reputation contract instance deployed.`);

                    // Mark as deployed.
                    this.cfg.contractInstance.status = ContractStatus.Deployed;
                    this.#persistConfig();
                }
            }
            else {
                console.log(`Skipping deploy since instance is not created in the moment ${curMoment}.`)
            }
        });
    }

    async #getScores() {
        if (!this.cfg.contractInstance?.domain || !this.cfg.contractInstance?.user_port)
            return null;

        let instanceMgr;
        try {
            instanceMgr = new ContractInstanceManager({
                ip: this.cfg.contractInstance.domain,
                userPort: this.cfg.contractInstance.user_port,
                userPrivateKey: this.cfg.contractInstance.owner_privatekey
            });

            await instanceMgr.init();
            const res = await instanceMgr.sendContractReadRequest({ command: this.#readScoreCmd }, INPUT_PROTOCOLS.json);
            return res;
        } catch (e) {
            console.error('Error occurred while reading the scores:', e);
            return null;
        }
        finally {
            if (instanceMgr)
                await instanceMgr.terminate();
        }
    }

    // Reputation sender.
    async #sendReputations() {
        const scheduledMoment = await this.hostClient.getMoment();

        await this.#queueAction(async (submissionRefs) => {
            const currentMoment = await this.hostClient.getMoment();

            if (scheduledMoment != currentMoment) {
                console.log(`Skipping reputation sender since scheduled moment has passed. Scheduled in ${scheduledMoment}, Current moment ${curMoment}.`);
                return;
            }

            // Sending reputations every moment.
            if (this.lastReputationMoment === 0 || currentMoment !== this.lastReputationMoment) {
                submissionRefs.refs ??= [{}];
                // Check again wether the transaction is validated before retry.
                const txHash = submissionRefs?.refs[0]?.submissionResult?.result?.tx_json?.hash;
                if (txHash) {
                    const txResponse = await this.hostClient.xrplApi.getTransactionValidatedResults(txHash);
                    if (txResponse && txResponse.code === "tesSUCCESS") {
                        console.log('Transaction is validated and success, Retry skipped!')
                        return;
                    }
                }

                let scores = null;
                if (this.cfg.contractInstance && this.cfg.contractInstance.created_timestamp &&
                    currentMoment === (await this.reputationClient.getMoment(this.cfg.contractInstance.created_timestamp) + 1))
                    scores = await this.#getScores();

                console.log(`Reporting reputations at Moment ${currentMoment} ${scores ? 'With scores' : 'Without scores'}...`);

                try {
                    await this.hostClient.sendReputations(scores, { submissionRef: submissionRefs?.refs[0], ...this.#prepareHostClientFunctionOptions() });
                    this.lastReputationMoment = await this.hostClient.getMoment();
                }
                catch (err) {
                    if (err.code === 'tecHOOK_REJECTED') {
                        console.log("Reputation rejected by the hook.");
                    }
                    else {
                        console.log("Reputation tx error", err);
                        throw err;
                    }
                }
            }
        }, this.#reputationRetryCount, this.#reputationRetryDelay);
    }

    #readConfig() {
        this.cfg = ConfigHelper.readConfig(this.#configPath, this.#mbXrplConfigPath, true);
    }

    #persistConfig() {
        ConfigHelper.writeConfig(this.cfg, this.#configPath);
    }
}

module.exports = {
    ReputationD
}