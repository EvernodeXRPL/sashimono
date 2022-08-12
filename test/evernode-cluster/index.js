const fs = require('fs').promises;
const { EvernodeService } = require('./evernode-service');
const { ContractInstanceManager } = require('./contract-instance-manager');
const HotPocket = require('hotpocket-js-client');

const CONFIG_FILE = "config.json";
const EVR_PER_MOMENT = 2;

class ClusterManager {
    #config = {};
    #evernodeService = null;

    async #readConfig() {
        const buf = await fs.readFile(CONFIG_FILE).catch(console.error);
        this.#config = JSON.parse(buf);
    }

    async #writeConfig() {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(this.#config, null, 2)).catch(console.error);
    }

    #getFundAmount() {
        const contractIdx = this.#config.contracts.findIndex(c => c.name === this.#config.selected);
        const contract = this.#config.contracts[contractIdx];
        const totalEvers = contract.target_instances_count * contract.target_moments_count * EVR_PER_MOMENT;


        return totalEvers;
    }

    async init() {
        await this.#readConfig();
        this.#evernodeService = new EvernodeService(this.#config.accounts);
        const fundAmount = this.#getFundAmount();
        await this.#evernodeService.init();
        await this.#evernodeService.prepareAccounts(fundAmount);
    }

    async deinit() {
        await this.#evernodeService.deinit();
        await this.#writeConfig();
    }

    async #createCluster(contractIdx, ownerKeys, targetNodesCount) {
        let hosts = await this.#evernodeService.getHosts();

        if (contractIdx < 0)
            throw `Contract ${this.#config.selected} is invalid.`

        const ownerPubKeyHex = Buffer.from(ownerKeys.publicKey).toString('hex');

        let createdInstanceCount = 0;

        while (createdInstanceCount < targetNodesCount) {

            if (!hosts || !hosts.length)
                throw "All the contract slots are occupied.";

            const contract = this.#config.contracts[contractIdx];
            const randomIndex = Math.floor(Math.random() * hosts.length);
            const host = hosts[randomIndex];
            if (host.activeInstances == host.maxInstances)
                continue;

            console.log(`Creating contract instance ${createdInstanceCount + 1} in ${host.address}`);

            let config = contract.config;

            if (!config.contract) {
                config.contract = {}
            }
            if (contract.cluster.length == 0)
                delete config.contract['unl'];
            else
                config.contract.unl = [contract.cluster[0].pubkey];

            if (!config.mesh) {
                config.mesh = {}
            }
            config.mesh.known_peers = contract.cluster.map(n => `${n.ip}:${n.peer_port}`);

            let instance
            try {
                instance = await this.#evernodeService.acquireLease(host, contract.contract_id, contract.docker_image, ownerPubKeyHex, config);
                if (!instance)
                    continue;
            }
            catch (e) {
                console.error(e);
                continue;
            }

            // Extending moments
            if (this.#config.target_moments_count > 1) {
                try {
                    const result = await this.#evernodeService.extendLease(host.address, instance.name, contract.target_moments_count - 1);
                    if (!result)
                        continue;
                } catch (e) {
                    console.error(e);
                    continue;
                };
            }

            this.#config.contracts[contractIdx].cluster.push(instance);
            hosts[randomIndex].activeInstances++;
            if (hosts[randomIndex].activeInstances == hosts[randomIndex].maxInstances)
                hosts.splice(randomIndex, 1);
            createdInstanceCount++;

            console.log(`Created contract instance ${createdInstanceCount} in ${host.address}`);
        }
    }

    async deploy() {
        const contractIdx = this.#config.contracts.findIndex(c => c.name === this.#config.selected);
        const contract = this.#config.contracts[contractIdx];
        const ownerKeys = await HotPocket.generateKeys(contract.owner_privatekey);

        await this.#createCluster(contractIdx, ownerKeys, this.#config.contracts[contractIdx].target_nodes_count - (contract?.cluster?.length || 0)).catch(e => {
            console.error(`Cluster create failed with.`, e);
        }).finally(async () => {
            await this.#writeConfig();
            return;
        });

        if (!contract.cluster || !contract.cluster.length) {
            console.error(`Contract ${this.#config.selected} cluster is empty.`);
            return;
        }

        const instance = contract.cluster[0];
        const instanceMgr = new ContractInstanceManager(ownerKeys, instance.pubkey, instance.ip, instance.user_port, instance.contractId, contract.bundle_path);

        console.log('Waiting 5 seconds until node are synced...');
        await new Promise(resolve => {
            setTimeout(() => {
                resolve();
            }, 5000);
        });

        console.log('Deploying the contract...');
        await instanceMgr.deployContract({
            unl: contract.cluster.map(n => n.pubkey)
        }).catch(e => {
            console.error(`Contract ${this.#config.selected} deployment failed with.`, e);
        });
        console.log('Successfully deployed the contract...');
    }
}


async function main() {
    const clusterMgr = new ClusterManager();
    await clusterMgr.init();
    await clusterMgr.deploy();
    await clusterMgr.deinit();
}

main().catch(console.error);