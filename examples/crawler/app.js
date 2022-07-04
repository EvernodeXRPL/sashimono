const { ContractInstanceManager } = require('./contract-instance-manager');
const evernode = require("evernode-js-client");
const process = require('process');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const args = process.argv.slice(2);
const tenantAddress = args[0] || "rKaXLGujsf8LokeQxG6TsoKVq8XWEMKpH";
const tenantSecret = args[1] || "ssorCEAHJFhZihUjCbx55j1mP6RnZ";
const intervalSec = (args[2] && parseInt(args[2])) || 60;

console.log(tenantAddress, intervalSec);

const registryAddress = "r3cNR2bdao1NyvQ5ZuQvCUgqkoWGmgF34E";
const evrIssuerAddress = "rfxLPXCcSmwR99dV97yFozBzrzpvCa2VCf";
const foundationAddress = "rppVLpTDks7tjAGw9TRcwqMGzuDvzV72Vh";
const foundationSecret = "shdAf9oUv1TLVTTR26Ke7w7Gv44HN";

const contractOwnerPrivateKey = "edfbbf5e66101cbf443c137b66c6b379bd4dfb8274015f7a0accd5cf3f4c640aa65cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50";
const contractOwnerPublicKey = "ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50";
const contractBundle = 'contract-bundle.zip';
const logFile = 'crawler.log';
const statsFile = 'stats.log';

let instancesCreated = 0;

async function fundTenant(tenant) {
    // Send evers to tenant if needed.
    const lines = await tenant.xrplAcc.getTrustLines('EVR', evrIssuerAddress);
    if (lines.length === 0 || parseInt(lines[0].balance) < 1) {
        await tenant.xrplAcc.setTrustLine('EVR', evrIssuerAddress, "99999999");
        await new evernode.XrplAccount(foundationAddress, foundationSecret).makePayment(tenantAddress, "100000", 'EVR', evrIssuerAddress);
    }
}

function appendLog(type, msg) {
    const str = '\n' + new Date().toUTCString() + '\n' + type + '\n' + JSON.stringify(msg) + '\n';
    fs.appendFileSync(logFile, str);
}

function updateStats(instancesCreated) {
    fs.writeFileSync(statsFile, JSON.stringify({
        instancesCreated: instancesCreated
    }))
}

async function acquireLease(tenant, host, instanceId, contractId, ownerPubKey) {
    if ((host.maxInstances - host.activeInstances) > 0) {
        try {
            console.log(`Acquiring lease in Host ${host.address} (currently ${host.activeInstances} instances)`);
            const result = await tenant.acquireLease(host.address, {
                container_name: instanceId,
                owner_pubkey: ownerPubKey,
                contract_id: contractId,
                image: "hp.latest-ubt.20.04-njs.16",
                config: {}
            }, { timeout: 60000 });
            console.log(`Tenant received instance '${result.instance.name}'`);
            return result.instance;
        }
        catch (err) {
            console.log("Tenant recieved acquire error: ", err)
            appendLog('AcquireError ' + host.address, err);
        }
    }
    else {
        console.log(`Host ${host.address} full.`);
    }

    return null;
}

async function spawnOnRandomHost(registry, tenant) {

    console.log("------------------------------------------");
    console.log(new Date().toUTCString());

    const hosts = await registry.getActiveHosts();

    if (hosts.length > 0) {
        const randomIndex = Math.floor(Math.random() * hosts.length);
        const host = hosts[randomIndex];

        const contractId = uuidv4();
        const instance = await acquireLease(tenant, host, contractId, contractId, contractOwnerPublicKey)

        if (instance) {
            console.log(`Received instance at ${new Date().toUTCString()}`, instance);
            const instanceMgr = new ContractInstanceManager(contractOwnerPrivateKey, instance.pubkey, instance.ip, instance.user_port, instance.contractId, contractBundle);

            try {
                await instanceMgr.deployContract();
                console.log('Instance deployed at', new Date().toUTCString());
                updateStats(++instancesCreated);

            }
            catch (err) {
                console.log("Contract deployment error.", err);
                appendLog('DeployError ' + instance.ip, err);
            }
        }
        else {
            console.log('Spawning skipped.');
        }
    }
    else {
        console.log("No active hosts.");
    }

    // Reschedule same call.
    setTimeout(() => {
        spawnOnRandomHost(registry, tenant);
    }, intervalSec * 1000);
}

async function crawler() {

    const xrplApi = new evernode.XrplApi('wss://hooks-testnet-v2.xrpl-labs.com');
    evernode.Defaults.set({
        registryAddress: registryAddress,
        xrplApi: xrplApi
    })
    await xrplApi.connect();

    const tenant = new evernode.TenantClient(tenantAddress, tenantSecret);
    await tenant.connect();
    await tenant.prepareAccount();
    await fundTenant(tenant);

    const registry = new evernode.RegistryClient();
    await registry.connect()

    // Recursive scheduled call.
    spawnOnRandomHost(registry, tenant);
}

crawler();