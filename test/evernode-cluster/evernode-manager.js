const evernode = require("evernode-js-client");
const { traceLog } = require("./logger");

const image = "hp.latest-ubt.20.04-njs.16";

class EvernodeManager {

    #xrplApi = null;
    #tenantClient = null;
    #registryClient = null;
    #confman = null;

    constructor(configManager) {
        this.#confman = configManager;
    }

    // async getAcquireSubmissionInfo(hostAddress) {
    //     await this.#initXrplApi();

    //     const tenantAcc = new evernode.XrplAccount(this.#confman.tenantAddress());
    //     const hostClient = new evernode.HostClient(hostAddress);
    //     const leaseOffers = await hostClient.getLeaseOffers();

    //     return {
    //         sequence: await tenantAcc.getSequence(),
    //         maxLedgerIndex: Math.ceil((this.#xrplApi.ledgerIndex + 30) / 10) * 10, // Get nearest 10th
    //         leaseOfferIndex: leaseOffers[0] && leaseOffers[0].index
    //     }
    // }

    // async getExtendSubmissionInfo() {
    //     await this.#initXrplApi();

    //     const tenantAcc = new evernode.XrplAccount(this.#confman.tenantAddress());

    //     return {
    //         sequence: await tenantAcc.getSequence(),
    //         maxLedgerIndex: Math.ceil((this.#xrplApi.ledgerIndex + 30) / 10) * 10, // Get nearest 10th
    //     }
    // }

    async getHosts() {
        const registryClient = await this.#getRegistryClient();
        const allHosts = await registryClient.getActiveHosts();
        return allHosts.filter(h => (h.maxInstances - h.activeInstances) > 0 && h.version !== "0.5.2");
    }

    // Udith Added
    async acquireLease(host, instanceId, contractId, ownerPubKey, unl = []) {
        try {
            const tenant = await this.#getTenantClient();
            console.log(`Acquiring lease in Host ${host.address} (currently ${host.activeInstances} instances)`);
            const result = await tenant.acquireLease(host.address, {
                container_name: instanceId,
                owner_pubkey: ownerPubKey,
                contract_id: contractId,
                image: "hp.latest-ubt.20.04-njs.16",
                config: {
                    contract: {
                        unl: unl
                    }
                }
            }, { timeout: 60000 });
            console.log(`Tenant received instance '${result.instance.name}'`);
            return result.instance;
        }
        catch (err) {
            console.log("Tenant recieved acquire error: ", err)
        }
    }

    createInstance(hostAddress, contractId, unl, roundtime, lclHash, options) {

        const requirements = {
            image: image,
            contract_id: contractId,
            owner_pubkey: this.#confman.ownerPubKey(),
            config: {
                contract: {
                    // Take only first unl pubkey to keep xrpl memo size within 1KB.
                    // Ths instance will automatically fetch full UNL when syncing.
                    unl: unl.sort().slice(0, 1),
                    roundtime: roundtime
                }
            }
        };

        return new Promise(async (resolve) => {

            const client = await this.#getTenantClient();
            const currentMoment = await client.getMoment();

            traceLog(`Creating instance. (current moment:${currentMoment})`);

            // Calculate determentistic crypto seed based on lcl hash for evernode payload encryption.
            const seed = Buffer.from(lclHash, "hex");
            let acquireTx = null;

            await client.acquireLeaseSubmit(hostAddress, requirements, {
                iv: seed.slice(0, 16),
                ephemPrivateKey: seed.slice(0, 32),
                transactionOptions: {
                    sequence: options.sequence,
                    maxLedgerIndex: options.maxLedgerIndex
                },
                leaseOfferIndex: options.leaseOfferIndex
            }).then(tx => {
                acquireTx = tx;
            }).catch(errtx => {
                if (errtx.submission && (errtx.submission.resultCode === "tefPAST_SEQ" || errtx.submission.resultCode === "tefALREADY")) {
                    acquireTx = errtx;
                    traceLog("Proceeding with pre-submitted acquire tx " + acquireTx.id)
                }
                else {
                    traceLog("acquire submit error", errtx);
                }
            }).finally(() => {
                if (acquireTx) {
                    client.watchAcquireResponse(acquireTx, { timeout: 120000 }).then(async (response) => {
                        resolve({
                            host: hostAddress,
                            instance: response.instance,
                            expireMoment: (currentMoment + 1)
                        });
                    }).catch(err => {
                        traceLog("acquire watch error", err);
                        resolve(null);
                    })
                }
                else {
                    resolve(null);
                }
            });
        })
    }

    async extendLease(hostAddress, instanceName, moments, options) {
        const client = await this.#getTenantClient();

        traceLog(`Extending lease ${instanceName} of host ${hostAddress} by ${moments} Moments.`);

        try {
            const result = await client.extendLease(hostAddress, moments, instanceName, {
                // timeout: 120000,
                transactionOptions: {
                    sequence: options.sequence,
                    maxLedgerIndex: options.maxLedgerIndex
                }
            });
            traceLog("Extend result", result);
            return true;
        }
        catch (err) {
            traceLog("Lease extend error", err);
            return false;
        }
    }

    async #initXrplApi() {
        if (!this.#xrplApi) {
            this.#xrplApi = new evernode.XrplApi(null, {
                xrplClientOptions: {
                    connectionTimeout: 10000
                }
            });
            evernode.Defaults.set({
                registryAddress: this.#confman.registryAddress(),
                xrplApi: this.#xrplApi
            })

            await this.#xrplApi.connect();
        }
        return this.#xrplApi;
    }

    async #getTenantClient() {
        if (!this.#tenantClient) {
            await this.#initXrplApi();
            this.#tenantClient = new evernode.TenantClient(this.#confman.tenantAddress(), this.#confman.tenantSecret());
            await this.#tenantClient.connect();
        }
        return this.#tenantClient;
    }

    async #getRegistryClient() {
        if (!this.#registryClient) {
            await this.#initXrplApi();
            this.#registryClient = new evernode.RegistryClient(this.#confman.registryAddress());
            await this.#registryClient.connect();
        }
        return this.#registryClient;
    }

    async disconnect() {
        if (this.#tenantClient) {
            await this.#tenantClient.disconnect();
            this.#tenantClient = null;
        }

        if (this.#xrplApi) {
            await this.#xrplApi.disconnect();
            this.#xrplApi = null;
        }
    }
}

module.exports = {
    EvernodeManager
}