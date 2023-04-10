const fs = require('fs').promises;
const { constants } = require('fs');
const { EvernodeService } = require('./evernode-service');
const { ContractInstanceManager } = require('./contract-instance-manager');
const HotPocket = require('hotpocket-js-client');

const CONFIG_FILE = "config.json";
const EVR_PER_MOMENT = 2;
const MAX_MEMO_PEER_LIMIT = 10;
const FAIL_THRESHOLD = 1;
const DEF_TIMEOUT = 60000;
const CLUSTER_CHUNK_RATIO = 0.2;

async function sleep(ms) {
    await new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, ms);
    });
}

class ClusterManager {
    #config = {};
    #evernodeService = null;
    #contractIdx;
    #instanceCount;
    #hosts;

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
                    "governor_address": "",
                    "foundation_address": "",
                    "foundation_secret": "",
                    "tenant_address": "",
                    "tenant_secret": "",
                    "primary_host_address": "",
                    "blacklist_hosts": [],
                    "preferred_hosts": []
                }
            };

            await fs.writeFile(CONFIG_FILE, JSON.stringify(configStructure, null, 2)).catch(console.error);
            console.log("config.json file created. Populate the config and run again.");
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
        const totalEvers = ((contract.target_nodes_count - contract.cluster.length) * EVR_PER_MOMENT) +
            ((contract.target_nodes_count - contract.cluster.filter(c => c.extended).length) * (contract.target_moments_count - 1) * EVR_PER_MOMENT);

        return totalEvers + Math.ceil(totalEvers * 25 / 100);
    }

    async init() {
        await this.#readConfig();
        this.#evernodeService = new EvernodeService(this.#config.accounts);
        const fundAmount = this.#getFundAmount();
        await this.#evernodeService.init();
        await this.#evernodeService.prepareAccounts(fundAmount);
        this.#contractIdx = this.#config.contracts.findIndex(c => c.name === this.#config.selected);
        this.#instanceCount = this.#config.contracts[this.#contractIdx]?.cluster?.length || 0;
        this.#hosts = (await this.#evernodeService.getHosts()).filter(h =>
            !this.#config.accounts.blacklist_hosts.includes(h.address) &&
            (!this.#config.accounts.preferred_hosts || !this.#config.accounts.preferred_hosts.length || this.#config.accounts.preferred_hosts.includes(h.address)))
            .sort(() => Math.random() - 0.5);
    }

    async terminate() {
        await this.#evernodeService.terminate();
        await this.#writeConfig();
    }

    async #createNode(nodeNumber, hostIndex, contract, ownerPubKeyHex, config) {
        const host = this.#hosts[hostIndex];
        if (host.activeInstances == host.maxInstances)
            throw { message: `Choosen host ${host.address} is occupied.`, innerException: `OCCUPIED` };

        // Wait until acquire completes.
        console.log(`Waiting until ${host.address} is available.`);
        while (this.#hosts[hostIndex].acquiring)
            await sleep(1000);

        this.#hosts[hostIndex].acquiring = true;

        console.log(`Creating node ${nodeNumber} in ${host.address}`);
        try {
            const instance = await this.#evernodeService.acquireLease(host, contract.contract_id, contract.docker_image, ownerPubKeyHex, config)
            if (!instance)
                throw 'INST_CREATE_ERR'
            console.log(`Created node ${nodeNumber} in ${host.address}`);
            this.#instanceCount++;
            this.#config.contracts[this.#contractIdx].cluster.push({ host: host.address, ...instance });
            this.#hosts[hostIndex].activeInstances++;
            this.#hosts[hostIndex].acquiring = false;

            return instance;
        }
        catch (e) {
            this.#hosts[hostIndex].acquiring = false;
            throw { message: `Error while creating the node ${nodeNumber} in ${host.address}.`, innerException: e };
        }
    }

    async #createPrimaryNode(ownerPubKeyHex) {
        const contract = this.#config.contracts[this.#contractIdx];
        const primaryHostAddress = this.#config.accounts.primary_host_address;

        let config = JSON.parse(JSON.stringify(contract.config));

        if (config.contract)
            delete config.contract['unl'];

        if (!config.mesh)
            config.mesh = {}

        config.mesh.msg_forwarding = true;

        let hostIndex = 0;
        if ((!this.#instanceCount || this.#instanceCount === 0) && primaryHostAddress) {
            hostIndex = this.#hosts.findIndex(h => h.address === primaryHostAddress);
            if (hostIndex < 0)
                throw { exitCode: 1, message: `Host ${primaryHostAddress} not found` };
        }
        await this.#createNode(1, hostIndex, contract, ownerPubKeyHex, config);
    }

    async #createNodes(count, ownerPubKeyHex) {
        const contract = this.#config.contracts[this.#contractIdx];

        let config = JSON.parse(JSON.stringify(contract.config));

        if (!config.contract) {
            config.contract = {}
        }
        config.contract.unl = [contract.cluster[0].pubkey];

        if (!config.mesh) {
            config.mesh = {}
        }
        const cluster = [...contract.cluster];
        // If cluster length is > MAX_MEMO_PEER_LIMIT pick MAX_MEMO_PEER_LIMIT random peers to limit the memo size.
        if (cluster.length > MAX_MEMO_PEER_LIMIT) {
            config.mesh.known_peers = cluster.sort(() => Math.random() - 0.5).slice(0, MAX_MEMO_PEER_LIMIT).map(n => `${n.ip}:${n.peer_port}`);
        }
        else {
            config.mesh.known_peers = cluster.map(n => `${n.ip}:${n.peer_port}`);
        }
        config.mesh.msg_forwarding = true;

        const promises = [...Array(count).keys()].map(async (v, i) => {
            await sleep(1000 * i);
            const nodeNumber = this.#instanceCount + i + 1;
            let hostIndex = (nodeNumber - 1) % this.#hosts.length;
            if (this.#hosts[hostIndex].failcount > FAIL_THRESHOLD) {
                hostIndex = Math.floor(Math.random() * this.#hosts.length);
            }
            await this.#createNode(nodeNumber, hostIndex, contract, ownerPubKeyHex, config).catch(e => {
                if (!this.#hosts[hostIndex].failcount)
                    this.#hosts[hostIndex].failcount = 1;
                else
                    this.#hosts[hostIndex].failcount++;
                console.error(e);
            });
        });

        await Promise.all(promises);
    }

    async #createCluster(ownerPubKeyHex) {
        const contract = this.#config.contracts[this.#contractIdx];
        let targetCount = contract.target_nodes_count - this.#instanceCount;

        if (targetCount > 0) {
            console.log(`Creating ${targetCount} nodes...`);

            // Create primary node.
            try {
                await this.#createPrimaryNode(ownerPubKeyHex);
                targetCount--;
            }
            catch (e) {
                throw { message: 'Error while creating the primary node.', innerException: e };
            }

            const clusterChunkSize = Math.ceil(targetCount * CLUSTER_CHUNK_RATIO)

            while (targetCount > 0) {
                try {
                    const curTarget = clusterChunkSize < targetCount ? clusterChunkSize : targetCount;
                    await this.#createNodes(curTarget, ownerPubKeyHex);
                    targetCount = contract.target_nodes_count - this.#instanceCount;
                }
                catch (e) {
                    console.error(e);
                }
            }

            return true;
        }

        return false;
    }

    async #extendCluster() {
        const contract = this.#config.contracts[this.#contractIdx];

        if (contract.target_moments_count > 1 && contract.cluster.findIndex(c => !c.extended) >= 0) {
            console.log('Extending the cluster...');

            const promises = contract.cluster.map(async (c, i) => {
                if (!contract.cluster[i].extended) {
                    try {
                        await sleep(2000 * i);
                        const result = await this.#evernodeService.extendLease(c.host, c.name, contract.target_moments_count - 1);
                        if (!result)
                            throw 'INST_EXTEND_ERR';
                        this.#config.contracts[this.#contractIdx].cluster[i].extended = true;
                        return result;
                    }
                    catch (e) {
                        console.error({ message: `Error while extending the node ${i + 1} in ${c.host}.`, innerException: e });
                    }
                }
            })

            await Promise.all(promises);
        }
    }

    async deploy() {
        let contract = this.#config.contracts[this.#contractIdx];
        const ownerKeys = await HotPocket.generateKeys(contract.owner_privatekey);
        const ownerPubKeyHex = Buffer.from(ownerKeys.publicKey).toString('hex');

        try {
            if (await this.#createCluster(ownerPubKeyHex)) {
                console.log('Waiting 15 seconds until nodes are synced...');
                await sleep(15000);
            }
        }
        catch (e) {
            await this.#writeConfig();
            throw e;
        }

        try {
            await this.#extendCluster();
        }
        catch (e) {
            await this.#writeConfig();
            throw e;
        }

        await this.#writeConfig();

        contract = this.#config.contracts[this.#contractIdx];
        const instance = contract.cluster[0];
        const instanceMgr = new ContractInstanceManager(ownerKeys, instance.pubkey, instance.ip, instance.user_port, instance.contractId, contract.bundle_path);

        console.log('Deploying the contract...');
        try {
            await instanceMgr.deployContract({
                unl: contract.cluster.map(n => n.pubkey)
            }, DEF_TIMEOUT);
        }
        catch (e) {
            throw { message: `Contract ${contract.name} deployment failed with.`, innerException: e };
        }

        console.log('Successfully deployed the contract...');
    }
}

async function main() {
    const clusterMgr = new ClusterManager();
    try {
        await clusterMgr.init();
        await clusterMgr.deploy();
    }
    catch (e) {
        await clusterMgr.terminate();
        throw e;
    }

    await clusterMgr.terminate();
}

main().catch(console.error);