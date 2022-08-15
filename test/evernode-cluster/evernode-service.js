const evernode = require("evernode-js-client");

class EvernodeService {
    #xrplApi;

    #registryAddress;
    #foundationAddress;
    #foundationSecret;

    #tenantAddress;
    #tenantSecret;

    #registryClient;
    #tenantClient;

    constructor(accounts) {
        this.#registryAddress = accounts.registry_address;
        this.#foundationAddress = accounts.foundation_address;
        this.#foundationSecret = accounts.foundation_secret;
        this.#tenantAddress = accounts.tenant_address;
        this.#tenantSecret = accounts.tenant_secret;
    }

    async #fundTenant(tenant, fundAmount) {
        // Send evers to tenant if needed.
        const lines = await tenant.xrplAcc.getTrustLines('EVR', tenant.config.evrIssuerAddress);
        if (lines.length === 0 || parseInt(lines[0].balance) < fundAmount) {
            await tenant.xrplAcc.setTrustLine('EVR', tenant.config.evrIssuerAddress, "99999999");
            await new evernode.XrplAccount(this.#foundationAddress, this.#foundationSecret).makePayment(this.#tenantAddress, fundAmount.toString(), 'EVR', tenant.config.evrIssuerAddress);
        }
    }

    async init() {
        this.#xrplApi = new evernode.XrplApi('wss://hooks-testnet-v2.xrpl-labs.com');
        evernode.Defaults.set({
            registryAddress: this.#registryAddress,
            xrplApi: this.#xrplApi
        })
        await this.#xrplApi.connect();

        this.#tenantClient = new evernode.TenantClient(this.#tenantAddress, this.#tenantSecret);
        await this.#tenantClient.connect();

        this.#registryClient = new evernode.RegistryClient();
        await this.#registryClient.connect();
    }

    async deinit() {
        await this.#tenantClient.disconnect();
        await this.#registryClient.disconnect();
        await this.#xrplApi.disconnect();
    }

    async prepareAccounts(fundAmount) {
        await this.#tenantClient.prepareAccount();
        await this.#fundTenant(this.#tenantClient, fundAmount);
    }

    async getHosts() {
        const allHosts = await this.#registryClient.getActiveHosts();
        return allHosts.filter(h => (h.maxInstances - h.activeInstances) > 0 && h.version !== "0.5.2");
    }

    async acquireLease(host, contractId, image, ownerPubKey, config) {
        let requirement = {
            owner_pubkey: ownerPubKey,
            contract_id: contractId,
            image: image,
            config: config ? config : {}
        };

        const tenant = this.#tenantClient;
        console.log(`Acquiring lease in Host ${host.address} (currently ${host.activeInstances} instances)`);
        const result = await tenant.acquireLease(host.address, requirement, { timeout: 60000 });
        console.log(`Tenant received instance '${result.instance.name}'`);
        return result.instance;
    }

    async extendLease(hostAddress, instanceName, moments) {
        const client = this.#tenantClient;
        console.log(`Extending lease ${instanceName} of host ${hostAddress} by ${moments} Moments.`);
        const result = await client.extendLease(hostAddress, moments, instanceName);
        console.log(`Instance ${instanceName} expiry set to ${result.expiryMoment}`);
        return result;
    }
}

module.exports = {
    EvernodeService
}

