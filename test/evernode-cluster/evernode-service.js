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
    
    constructor (configs) {
        let acc = configs.accounts;
        this.registryAddress = acc.registryAddress;
        this.evrIssuerAddress = acc.evrIssuerAddress;
        this.foundationAddress = acc.foundationAddress;
        this.foundationSecret = acc.foundationSecret;
        this.tenantAddress = acc.tenantAddress;
        this.tenantSecret = acc.tenantSecret;
    
    
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
    async acquireLease(host, contractId, image, ownerPubKey, unl = []) {

        let requirement = {
                owner_pubkey: ownerPubKey,
                contract_id: contractId,
                image: image,
        };

        if (unl.length > 0)
        requirement.config = {
            contract: {
                unl: unl.slice(0,1)
            }
        };

        try {
            const tenant = this.tenantClient;
            console.log(`Acquiring lease in Host ${host.address} (currently ${host.activeInstances} instances)`);
            const result = await tenant.acquireLease(host.address, {
                owner_pubkey: ownerPubKey,
                contract_id: contractId,
                image: "hp.latest-ubt.20.04-njs.16",
                config: cf
            }, { timeout: 60000 });
            console.log(`Tenant received instance '${result.instance.name}'`);
            return result.instance;
        }
        catch (err) {
            console.log("Tenant recieved acquire error: ", err)
        }
    }

    async extendLease(hostAddress, instanceName, moments, options) {
        const client = this.tenantClient;

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
}

module.exports = {
    EvernodeService
}

