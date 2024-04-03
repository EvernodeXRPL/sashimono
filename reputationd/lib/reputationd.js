const fs = require('fs');
const evernode = require('evernode-js-client');
const crypto = require('crypto');
const uuid = require('uuid');
const { appenv } = require('./appenv');
const { ConfigHelper } = require('./config-helper');
const { CliHelper } = require('./cli-handler');

class ReputationD {
    #concurrencyQueue = {
        processing: false,
        queue: []
    };
    #applyFeeUpliftment = false;
    #reputationRetryDelay = 300000; // 5 mins
    #reputationRetryCount = 3;
    #feeUpliftment = 0;
    #reportTimeQuota = 0.9; // Percentage of moment size.
    #contractInitTimeQuota = 0.1; // Percentage of moment size.
    #scoreFilePath = `/home/#USER#/#INSTANCE#/contract_fs/mnt/opinion.txt`

    #configPath;
    #secretConfigPath;
    #mbXrplConfigPath;
    #instanceImage;

    constructor(configPath, secretConfigPath, mbXrplConfigPath, instanceImage) {
        this.#configPath = configPath;
        this.#secretConfigPath = secretConfigPath;
        this.#mbXrplConfigPath = mbXrplConfigPath;
        this.#instanceImage = instanceImage;
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

        this.hostClient = new evernode.HostClient(this.cfg.xrpl.hostAddress);
        await this.#connectHost();

        console.log("Using,");
        console.log("\tGovernor account " + this.cfg.xrpl.governorAddress);
        console.log("\tReputation account " + this.hostClient.config.reputationAddress);
        console.log("Using rippled " + this.cfg.xrpl.rippledServer);

        // Get last heartbeat moment from the host info.
        let hostInfo = await this.hostClient.getRegistration();
        if (!hostInfo)
            throw "Host is not registered.";

        await this.hostClient.setReputationAcc(this.cfg.xrpl.address, this.cfg.xrpl.secret);

        this.regClient = await evernode.HookClientFactory.create(evernode.HookTypes.registry);

        await this.#connectRegistry();

        this.lastReputationMoment = 0;

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

    #startReputationClockScheduler() {
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
        const momentStartTime = await this.hostClient.getMomentStartIndex();
        const currentTime = evernode.UtilHelpers.getCurrentUnixTime();

        if ((currentTime - momentStartTime) < (momentSize * this.#reportTimeQuota))
            startTimeout = (momentStartTime + (momentSize * this.#reportTimeQuota) - currentTime) * 1000 // Converting seconds to milliseconds.

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
        const momentStartTime = await this.hostClient.getMomentStartIndex();
        const currentTime = evernode.UtilHelpers.getCurrentUnixTime();

        if ((currentTime - momentStartTime) > (momentSize * this.#contractInitTimeQuota))
            startTimeout = (momentStartTime + momentSize - currentTime) * 1000 // Converting seconds to milliseconds.

        console.log(`Reputation contract creation scheduled to start in ${startTimeout} milliseconds.`);

        setTimeout(async () => {
            await scheduler();
        }, startTimeout);
    }

    async #getUniverseInfo() {
        // TODO: Collect the universe info.
        return {
            id: '',
            hosts: ''
        };
    }

    async #getInstancesInUniverse(universeId) {
        // TODO: Collect the universe info.
        return [];
    }

    // Find the universe id and generate contract id.
    async #generateContractId(universeId) {
        // Generate a hash from the seed
        const hash = crypto.createHash('sha1').update(universeId).digest('hex');
        // Use a portion of the hash to generate a random UUID
        const id = uuid.v4({
            random: Buffer.from(hash.substring(0, 16), 'hex')
        });

        return id;
    }

    // Create and setup reputation contract.
    async #createReputationContract() {
        await this.#queueAction(async (submissionRefs) => {
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

            const tenantClient = new evernode.TenantClient(this.hostClient.reputationAcc.address, this.hostClient.reputationAcc.secret);
            await tenantClient.connect();
            await tenantClient.prepareAccount();

            const universeInfo = await this.#getUniverseInfo();
            const requirement = {
                owner_pubkey: ownerPubkey,
                contract_id: await this.#generateContractId(universeInfo.id),
                image: this.#instanceImage,
                config: {
                    contract: {
                        consensus: {
                            roundtime: 5000
                        }
                    }
                }
            };

            // Update the registry with the active instance count.
            const result = await tenantClient.acquireLease(this.hostClient.xrplAcc.address, requirement, {});

            await tenantClient.disconnect();

            const acquiredTimestamp = Date.now();

            // Assign ip to domain and outbound_ip for instance created from old sashimono version.
            if ('ip' in result.instance) {
                result.instance.domain = result.instance.ip;
                delete result.instance.ip;
            }

            this.cfg.contractInstance = { ...result.instance, created_timestamp: acquiredTimestamp };
            this.#persistConfig();

            const instances = this.#getInstancesInUniverse(universeInfo.id);
            const overrideConfig = {
                unl: instances.map(p => `${p.pubkey}`),
                contract: {
                    consensus: {
                        roundtime: 2000
                    }
                },
                mesh: {
                    known_peers: instances.map(p => `${p.domain}:${p.port}`)
                }
            };

            // TODO: Deploy the contract.
        });
    }

    async #getScores() {
        const instanceName = this.cfg.contractInstance.name;
        if (!instanceName)
            return null;

        const instances = await CliHelper.listInstances();

        const instance = instances.find(i => i.name === instanceName);

        if (!instance) {
            this.cfg.contractInstance = {};
            this.#persistConfig();

            return null;
        }

        const path = this.#scoreFilePath.replace('#USER#', instance.user).replace('#INSTANCE#', instance.name);

        if (!fs.existsSync(path))
            return null;

        return JSON.parse(path);
    }

    // Reputation sender.
    async #sendReputations() {
        await this.#queueAction(async (submissionRefs) => {
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

            // TODO: Get reputation scores from the contract.
            const scores = await this.#getScores();

            let ongoingReputation = false;
            const currentMoment = await this.hostClient.getMoment();

            // Sending reputations every moment.
            if (!ongoingReputation && (this.lastReputationMoment === 0 || currentMoment !== this.lastReputationMoment)) {
                ongoingReputation = true;
                console.log(`Reporting reputations at Moment ${currentMoment}...`);

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
                finally {
                    ongoingReputation = false;
                }
            }
        }, this.#reputationRetryCount, this.#reputationRetryDelay);
    }

    #readConfig() {
        this.cfg = ConfigHelper.readConfig(this.#configPath, this.#secretConfigPath, this.#mbXrplConfigPath);
    }

    #persistConfig() {
        ConfigHelper.writeConfig(this.cfg, this.#configPath);
    }
}

module.exports = {
    ReputationD
}