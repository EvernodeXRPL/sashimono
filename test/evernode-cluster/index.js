const fs  = require('fs').promises;
const { EvernodeService } = require('./evernode-service');
const { ContractInstanceManager } = require('./contract-instance-manager');

const configFile = "config.json";

let configs = {};
let hosts = [];
let evernodeService = null;
let unlList = [];
let peers = [];

async function readConfigs(configFile) {
    const buf = await fs.readFile(configFile)

    if (buf) {
        return JSON.parse(buf);
        // Validation
    }
}

async function createCluster() {
    hosts = evernodeService.getHosts();
    contract = configs.contracts.filter(c => c.name === configs.selected)[0];

    let instances = [];

    let createdInstanceCount = 0;
    while (createdInstanceCount < contract.target_instances_count) {
        const randomIndex = Math.floor(Math.random() * hosts.length);
        const host = hosts[randomIndex];
        if (host.activeInstances == host.maxInstances)
            continue;

        let instance;
        if (unlList.legth == 0) {
            instance = await evernodeService.acquireLease(host, contract.contract_id, contract.docker_image, contract.roundtime, contract.owner_pubkey);
        }
        else {
            instance = await evernodeService.acquireLease(host, contract.contract_id, contract.docker_image, contract.roundtime, contract.owner_pubkey, unlList);
        }
        instances.push(instance);
        unlList.push(instance.pubkey);
        peers.push(`${instance.ip}:${instance.peer_port}`);

        // Extending moments
        let isExtendingSuccess = false;
        if (configs.target_moments_count > 1) {
            isExtendingSuccess = await evernodeService.extendLease(host.address, instance.name, contract.target_moments_count - 1, options);    // options need to be defined]
        }
        if (!isExtendingSuccess) {
            // If extending fails in any instance, moment count is set to 1 for the rest of the instances
            contract.target_moments_count = 1;
        }

        hosts[randomIndex].activeInstances++;
        createdInstanceCount++;
    }




}


async function main() {
    // init();
    const configs = await readConfigs(configFile);
    // evernodeService = new EvernodeService(configs);
    // let fundAmount = "100000";   // Calculate
    // await evernodeService.prepareAccounts(fundAmount);
    // await createCluster();
    
    const contract = configs.contracts[0];
    const instance = contract.cluster[0];
    const instanceMgr = new ContractInstanceManager(contract.owner_pvtkey, instance.pubkey, instance.ip, instance.user_port, instance.contractId, contract.bundle_path);

    await instanceMgr.deployContract({
        unl: contract.cluster.map(n => n.pubkey)
    });
}

main().catch(console.error);