const fs = require('fs').promises;
const { constants } = require('fs');
const { EvernodeService } = require('./evernode-service');
const { ContractInstanceManager } = require('./contract-instance-manager');
const HotPocket = require('hotpocket-js-client');

const CONFIG_FILE = "config.json";
const EVR_PER_MOMENT = 2;

class ClusterManager {
    #config = {};
    #evernodeService = null;

    async #readConfig() {
        let isConfigExists;
        try {
            await fs.access(CONFIG_FILE, constants.R_OK);
            isConfigExists = true;
        } catch {
            isConfigExists = false;
        }

        if (!isConfigExists) {
            console.log('File config.json not found.\nCreating a sample config.json...');
            const configStructure = {
                "selected": "",
                "contracts": [
                    {
                        "name": "",
                        "owner_privatekey": "",
                        "contract_id": "",
                        "bundle_path": "",
                        "docker_image": "",
                        "config": {},
                        "target_nodes_count": 1,
                        "target_moments_count": 1,
                        "cluster": []
                    }
                ],
                "accounts": {
                    "registryAddress": "",
                    "foundationAddress": "",
                    "foundationSecret": "",
                    "tenantAddress": "",
                    "tenantSecret": "",
                    "primaryHostAddress": ""
                }
            };

            await fs.writeFile(CONFIG_FILE, JSON.stringify(configStructure, null, 2)).catch(console.error);
            console.log("Complete the config.json created and rerun the program.");
            process.exit(1);

        }

        const buf = await fs.readFile(CONFIG_FILE).catch(console.error);
        this.#config = JSON.parse(buf);
    }

    async #writeConfig() {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(this.#config, null, 2)).catch(console.error);
    }

    #getFundAmount() {
        const contractIdx = this.#config.contracts.findIndex(c => c.name === this.#config.selected);
        const contract = this.#config.contracts[contractIdx];
        const totalEvers = (contract.target_nodes_count * contract.target_moments_count * EVR_PER_MOMENT) + 100;

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

    async #createNode(host, ownerPubkey, contract, weakCluster = false) {
        let config = JSON.parse(JSON.stringify(contract.config));

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
        if (weakCluster)
            config.mesh.msg_forwarding = true;

        const instance = await this.#evernodeService.acquireLease(host, contract.contract_id, contract.docker_image, ownerPubkey, config);
        if (!instance)
            throw 'Error while creating the intance.';

        // Extending moments
        if (this.#config.target_moments_count > 1) {
            const result = await this.#evernodeService.extendLease(host.address, instance.name, contract.target_moments_count - 1);
            if (!result)
                throw 'Error while extending the intance.';
        }

        return instance;
    }

    async #createCluster(contractIdx, ownerKeys, targetNodesCount) {
        let hosts = await this.#evernodeService.getHosts();

        if (contractIdx < 0)
            throw `Contract ${this.#config.selected} is invalid.`

        const ownerPubKeyHex = Buffer.from(ownerKeys.publicKey).toString('hex');
        const primaryHostAddress = this.#config.accounts.primaryHostAddress;

        let createdInstanceCount = 0;

        while (createdInstanceCount < targetNodesCount) {

            if (!hosts || !hosts.length)
                throw "All the contract slots are occupied.";

            let randomIndex = 0;
            if (createdInstanceCount === 0 && primaryHostAddress) {
                randomIndex = hosts.findIndex(h => h.address === primaryHostAddress);
                if (randomIndex < 0)
                    throw `Host ${primaryHostAddress} not found`;
            }
            else
                randomIndex = Math.floor(Math.random() * hosts.length);

            const host = hosts[randomIndex];
            if (host.activeInstances == host.maxInstances)
                continue;

            console.log(`Creating node ${createdInstanceCount + 1} in ${host.address}`);

            let instance;
            try {
                instance = await this.#createNode(host, ownerPubKeyHex, this.#config.contracts[contractIdx]);
            }
            catch (e) {
                console.error(`Node ${createdInstanceCount + 1} creation in ${host.address} failed.`, e);
                continue;
            }

            this.#config.contracts[contractIdx].cluster.push(instance);
            hosts[randomIndex].activeInstances++;
            if (hosts[randomIndex].activeInstances == hosts[randomIndex].maxInstances)
                hosts.splice(randomIndex, 1);
            createdInstanceCount++;

            console.log(`Created node ${createdInstanceCount} in ${host.address}`);
        }
    }

    async deploy() {
        const contractIdx = this.#config.contracts.findIndex(c => c.name === this.#config.selected);
        const contract = this.#config.contracts[contractIdx];
        const ownerKeys = await HotPocket.generateKeys(contract.owner_privatekey);

        await this.#createCluster(contractIdx,
            ownerKeys,
            this.#config.contracts[contractIdx].target_nodes_count - (contract?.cluster?.length || 0)).catch(e => {
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
            return;
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