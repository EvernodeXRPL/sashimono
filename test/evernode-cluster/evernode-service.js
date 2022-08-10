const evernode = require("evernode-js-client");

class EvernodeService {

    registryAddress;
    evrIssuerAddress;
    foundationAddress;
    foundationSecret;
    
    tenantAddress;
    tenantSecret;

    registryClient;
    tenantClient;
    
    async fundTenant(tenant, fundAmount) {
        // Send evers to tenant if needed.
        const lines = await tenant.xrplAcc.getTrustLines('EVR', evrIssuerAddress);
        if (lines.length === 0 || parseInt(lines[0].balance) < 1) {
            await tenant.xrplAcc.setTrustLine('EVR', evrIssuerAddress, "99999999");
            await new evernode.XrplAccount(foundationAddress, foundationSecret).makePayment(tenantAddress, fundAmount, 'EVR', evrIssuerAddress);
        }
    }
    
    constructor (accounts) {
        this.registryAddress = accounts.registryAddress;
        this.evrIssuerAddress = accounts.evrIssuerAddress;
        this.foundationAddress = accounts.foundationAddress;
        this.foundationSecret = accounts.foundationSecret;
        this.tenantAddress = accounts.tenantAddress;
        this.tenantSecret = accounts.tenantSecret;    
    }
    
    async prepareAccounts(fundAmount) {
        const xrplApi = new evernode.XrplApi('wss://hooks-testnet-v2.xrpl-labs.com');
        evernode.Defaults.set({
            registryAddress: this.registryAddress,
            xrplApi: xrplApi
        })
        await xrplApi.connect();
    
        this.tenantClient = new evernode.TenantClient(this.tenantAddress, this.tenantSecret);
        await this.tenantClient.connect();
        await this.tenantClient.prepareAccount();
        await fundTenant(this.tenantClient, fundAmount);
    
        this.registryClient = new evernode.RegistryClient();
        await this.registryClient.connect()
    }

    async getHosts() {
        const allHosts = await this.registryClient.getActiveHosts();
        return allHosts.filter(h => (h.maxInstances - h.activeInstances) > 0 && h.version !== "0.5.2");
    }

    // Udith Added
    async acquireLease(host, contractId, image, ownerPubKey, config) {

        let requirement = {
                owner_pubkey: ownerPubKey,
                contract_id: contractId,
                image: image,
                config: config ? config : {}
        };

        const tenant = this.tenantClient;
        console.log(`Acquiring lease in Host ${host.address} (currently ${host.activeInstances} instances)`);
        const result = await tenant.acquireLease(host.address, requirement, { timeout: 60000 });
        console.log(`Tenant received instance '${result.instance.name}'`);
        return result.instance;
    }

    async extendLease(hostAddress, instanceName, moments) {
        const client = this.tenantClient;

        console.log(`Extending lease ${instanceName} of host ${hostAddress} by ${moments} Moments.`);
        const result = await client.extendLease(hostAddress, moments, instanceName);
        console.log("Extend result", result);
        return result;
    }
}

module.exports = {
    EvernodeService
}

