const fs = require('fs').promises;
const { EvernodeService } = require('./evernode-service');
const { ContractInstanceManager } = require('./contract-instance-manager');

const configFile = "config.json";

let config = {};
let evernodeService = null;

async function readConfig(configFile) {
    const buf = await fs.readFile(configFile).catch(console.error);

    if (buf) {
        return JSON.parse(buf);
        // Validation
    }
}

async function saveConfig(configFile) {
    await fs.writeFile(configFile, JSON.stringify(config, null, 2)).catch(console.error);
}

async function createCluster(contractIdx) {
    let hosts = evernodeService.getHosts();

    if (contractIdx < 0)
        throw `Contract ${config.selected} is invalid.`

    let createdInstanceCount = 0;
    while (createdInstanceCount < config.contracts[contractIdx].target_instances_count) {
        if (!hosts || !hosts.length)
            throw "All the contract slots are occupied.";

        const contract = config.contracts[contractIdx];
        const randomIndex = Math.floor(Math.random() * hosts.length);
        const host = hosts[randomIndex];
        if (host.activeInstances == host.maxInstances)
            continue;

        let instance;
        let config = contract.config;
        if (contract.cluster.legth == 0)
            delete config['unl'];
        else
            config.unl = [contract.cluster[0].pubkey];
        config.mesh.known_peers = contract.cluster.map(n => `${n.ip}:${n.peer_port}`);
        const instance = await evernodeService.acquireLease(host, contract.contract_id, contract.docker_image, contract.roundtime, contract.owner_pubkey, config).catch(e => {
            console.error(e);
            continue;
        });
        if (!instance)
            continue;

        // Extending moments
        if (config.target_moments_count > 1) {
            const result = await evernodeService.extendLease(host.address, instance.name, contract.target_moments_count - 1).catch(e => {
                console.error(e);
                continue;
            });
            if (!result)
                continue;
        }

        config.contracts[contractIdx].cluster.push(instance);
        hosts[randomIndex].activeInstances++;
        if (hosts[randomIndex].activeInstances == hosts[randomIndex].maxInstances)
            hosts.splice(randomIndex, 1);
        createdInstanceCount++;
    }
}


async function main() {
    // init();
    config = await readConfig(configFile);
    evernodeService = new EvernodeService(config.accounts);
    let fundAmount = "100000";   // Calculate
    await evernodeService.prepareAccounts(fundAmount);

    const contractIdx = config.contracts.findIndex(c => c.name === config.selected);
    await createCluster(contractIdx).catch(e => {
        console.error(`Cluster create failed with.`, e);
    }).finally(() => {
        await saveConfig(configFile);
    });

    const contract = config.contracts[contractIdx];

    if (!contract.cluster || !contract.cluster.length) {
        console.error(`Contract ${config.selected} cluster is empty.`);
        return;
    }

    const instance = contract.cluster[0];
    const instanceMgr = new ContractInstanceManager(contract.owner_pvtkey, instance.pubkey, instance.ip, instance.user_port, instance.contractId, contract.bundle_path);

    await instanceMgr.deployContract({
        unl: contract.cluster.map(n => n.pubkey)
    }).catch(e => {
        console.error(`Contract ${config.selected} deployment failed with.`, e);
    });
}

main().catch(console.error);