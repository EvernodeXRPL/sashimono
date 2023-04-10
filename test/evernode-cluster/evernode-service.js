const evernode = require("evernode-js-client");

class EvernodeService {
    #xrplApi;

    #governorAddress;
    #foundationAddress;
    #foundationSecret;

    #tenantAddress;
    #tenantSecret;

    #registryClient;
    #governorClient;
    #tenantClient;

    constructor(accounts) {
        this.#governorAddress = accounts.governor_address;
        this.#foundationAddress = accounts.foundation_address;
        this.#foundationSecret = accounts.foundation_secret;
        this.#tenantAddress = accounts.tenant_address;
        this.#tenantSecret = accounts.tenant_secret;
    }

    async fundTenant(fundAmount = 6000) {
        // Send evers to tenant if needed.
        let lines = await this.#tenantClient.xrplAcc.getTrustLines('EVR', this.#tenantClient.config.evrIssuerAddress);
        if (lines.length === 0) {
            await this.#tenantClient.xrplAcc.setTrustLine('EVR', this.#tenantClient.config.evrIssuerAddress, "99999999");
            lines = await this.#tenantClient.xrplAcc.getTrustLines('EVR', this.#tenantClient.config.evrIssuerAddress);
        }

        if (parseInt(lines[0].balance) < fundAmount) {
            const amount = (fundAmount - lines[0].balance).toString();
            console.log(`Funding ${amount} EVRs to ${this.#tenantAddress}`)
            await new evernode.XrplAccount(this.#foundationAddress, this.#foundationSecret).makePayment(this.#tenantAddress, amount, 'EVR', this.#tenantClient.config.evrIssuerAddress);
        }
    }

    async init() {
        this.#xrplApi = new evernode.XrplApi('wss://hooks-testnet-v3.xrpl-labs.com');
        evernode.Defaults.set({
            governorAddress: this.#governorAddress,
            xrplApi: this.#xrplApi,
            networkID: 21338
        })
        await this.#xrplApi.connect();

        this.#tenantClient = new evernode.TenantClient(this.#tenantAddress, this.#tenantSecret);
        await this.#tenantClient.connect();

        this.#governorClient = await evernode.HookClientFactory.create(evernode.HookTypes.governor);
        await this.#governorClient.connect();

        this.#registryClient = await evernode.HookClientFactory.create(evernode.HookTypes.registry);
        await this.#registryClient.connect();
    }

    async terminate() {
        await this.#tenantClient.disconnect();
        await this.#registryClient.disconnect();
        await this.#governorClient.disconnect();
        await this.#xrplApi.disconnect();
    }

    async prepareAccounts(fundAmount) {
        await this.#tenantClient.prepareAccount();
        await this.fundTenant(fundAmount);
    }

    async getHosts() {
        const allHosts = await this.#registryClient.getActiveHosts();
        return allHosts.filter(h => (h.maxInstances - h.activeInstances) > 0 && h.version >= "0.6.0");
    }

    async acquireLease(host, contractId, image, ownerPubKey, config, timeout = 60000) {
        let requirement = {
            owner_pubkey: ownerPubKey,
            contract_id: contractId,
            image: image,
            config: config ? config : {}
        };

        const tenant = this.#tenantClient;
        console.log(`Acquiring lease in Host ${host.address} (currently ${host.activeInstances} instances)`);
        const result = await tenant.acquireLease(host.address, requirement, { timeout: timeout });
        console.log(`Tenant received instance '${result.instance.name}'`);
        return result.instance;
    }

    async extendLease(hostAddress, instanceName, moments) {
        const tenant = this.#tenantClient;
        console.log(`Extending lease ${instanceName} of host ${hostAddress} by ${moments} Moments.`);
        const result = await tenant.extendLease(hostAddress, moments, instanceName);
        console.log(`Instance ${instanceName} expiry set to ${result.expiryMoment}`);
        return result;
    }
}

module.exports = {
    EvernodeService
}

