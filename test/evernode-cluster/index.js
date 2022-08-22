const fs = require('fs').promises;
const { constants } = require('fs');
const { EvernodeService } = require('./evernode-service');
const { ContractInstanceManager } = require('./contract-instance-manager');
const HotPocket = require('hotpocket-js-client');

const CONFIG_FILE = "config.json";
const EVR_PER_MOMENT = 2;
const MAX_MEMO_PEER_LIMIT = 10;

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
                        "parallel_mode": false,
                        "cluster": []
                    }
                ],
                "accounts": {
                    "registry_address": "",
                    "foundation_address": "",
                    "foundation_secret": "",
                    "tenant_address": "",
                    "tenant_secret": "",
                    "primary_host_address": "",
                    "blacklist_hosts": []
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
    }

    async terminate() {
        await this.#evernodeService.terminate();
        await this.#writeConfig();
    }

    async #createNode(ctx, ownerPubKeyHex, weakCluster = false) {
        if (!ctx.hosts || !ctx.hosts.length)
            throw { exitCode: 1, message: "All the hosts are occupied." };

        const primaryHostAddress = this.#config.accounts.primary_host_address;
        const contract = this.#config.contracts[ctx.contractIdx];

        let randomIndex = 0;
        if ((!ctx.existingCount || ctx.existingCount === 0) && ctx.createdInstanceCount === 0 && primaryHostAddress) {
            randomIndex = ctx.hosts.findIndex(h => h.address === primaryHostAddress);
            if (randomIndex < 0)
                throw { exitCode: 1, message: `Host ${primaryHostAddress} not found` };
        }
        else
            randomIndex = Math.floor(Math.random() * ctx.hosts.length);

        const host = ctx.hosts[randomIndex];
        if (host.activeInstances == host.maxInstances)
            throw { exitCode: 0, message: `All the contract slots in ${host.address} are occupied.` };

        // Wait until acquire completes.
        console.log(`Waiting until ${host.address} is available.`);
        while (ctx.hosts[randomIndex].acquiring)
            await sleep(1000);

        ctx.hosts[randomIndex].acquiring = true;

        ctx.createdInstanceCount++;
        const nodeNumber = (ctx.existingCount || 0) + ctx.createdInstanceCount;
        console.log(`Creating node ${nodeNumber} in ${host.address}`);

        let instance;
        try {
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
            const cluster = [...contract.cluster];
            // If cluster length is > MAX_MEMO_PEER_LIMIT pick MAX_MEMO_PEER_LIMIT random peers to limit the memo size.
            if (cluster.length > MAX_MEMO_PEER_LIMIT) {
                config.mesh.known_peers = cluster.sort(() => Math.random() - 0.5).slice(0, MAX_MEMO_PEER_LIMIT).map(n => `${n.ip}:${n.peer_port}`);
            }
            else {
                config.mesh.known_peers = cluster.map(n => `${n.ip}:${n.peer_port}`);
            }
            if (weakCluster)
                config.mesh.msg_forwarding = true;

            instance = await this.#evernodeService.acquireLease(host, contract.contract_id, contract.docker_image, ownerPubKeyHex, config);
            if (!instance)
                throw { exitCode: 0, message: 'Error while creating the intance.' };
        }
        catch (e) {
            if (e.reason === 'TRANSACTION_FAILURE' && e.content?.code === 'tecINSUFFICIENT_FUNDS')
                throw { exitCode: 1, message: e };
            console.error(`Node ${nodeNumber} creation in ${host.address} failed.`, e);
            ctx.createdInstanceCount--;
            ctx.hosts[randomIndex].acquiring = false;
            throw e;
        }

        this.#config.contracts[ctx.contractIdx].cluster.push({ host: host.address, ...instance });
        ctx.hosts[randomIndex].activeInstances++;
        ctx.hosts[randomIndex].acquiring = false;

        console.log(`Created node ${nodeNumber} in ${host.address}`);
    }

    async #createCluster(contractIdx, ownerKeys, targetNodesCount, parallel = false) {
        if (contractIdx < 0)
            throw `Contract ${this.#config.selected} is invalid.`

        let ctx = {
            hosts: await this.#evernodeService.getHosts(),
            createdInstanceCount: 0,
            contractIdx: contractIdx,
            existingCount: this.#config.contracts[contractIdx].cluster.length
        }

        if (this.#config.accounts.blacklist_hosts && this.#config.accounts.blacklist_hosts.length > 0)
            ctx.hosts = ctx.hosts.filter(h => !this.#config.accounts.blacklist_hosts.includes(h.address))

        const ownerPubKeyHex = Buffer.from(ownerKeys.publicKey).toString('hex');

        if (!parallel) {
            while (ctx.createdInstanceCount < targetNodesCount) {
                try {
                    await this.#createNode(ctx, ownerPubKeyHex, targetNodesCount > MAX_MEMO_PEER_LIMIT);
                }
                catch (e) {
                    if (e.exitCode && e.exitCode === 1)
                        throw e.message || e;
                    else
                        console.error(e.message || e)
                }
            }
        }
        else {
            const createNodes = async (nodesCount) => {
                const res = await Promise.all([...Array(nodesCount).keys()].map(async (v, i) => {
                    await sleep(1000 * i);
                    try {
                        return await this.#createNode(ctx, ownerPubKeyHex, true);
                    }
                    catch (e) {
                        return e
                    }
                }));
                const err = res.find(e => e?.exitCode && e?.exitCode === 1);
                if (err) {
                    throw (err.message || err);
                }
            };

            if (this.#config.accounts.primary_host_address && (!ctx.existingCount || ctx.existingCount === 0) && ctx.createdInstanceCount === 0) {
                try {
                    await this.#createNode(ctx, ownerPubKeyHex, true);
                }
                catch (e) {
                    throw { message: `Instance creation on primary host ${this.#config.accounts.primary_host_address} failed.`, content: e.message || e };
                }
            }
            while (ctx.createdInstanceCount < targetNodesCount) {
                const count = targetNodesCount - ctx.createdInstanceCount;
                try {
                    await createNodes(count > 2 ? Math.ceil(count / 2) : count);
                    if (targetNodesCount - ctx.createdInstanceCount > 0)
                        await createNodes(targetNodesCount - ctx.createdInstanceCount);
                }
                catch (e) {
                    throw e;
                }
            }
        }
    }

    async #extendCluster(contractIdx) {
        const contract = this.#config.contracts[contractIdx];
        const res = await Promise.all(contract.cluster.map(async (c, i) => {
            if (!c.extended) {
                await sleep(1000 * i);
                try {
                    const result = await this.#evernodeService.extendLease(c.host, c.name, contract.target_moments_count - 1);
                    if (!result)
                        return { error: `Error while extending the intance ${c.name} in ${c.host}.` };
                    this.#config.contracts[contractIdx].cluster[i].extended = true;
                    return result;
                }
                catch (e) {
                    return { error: e };
                }
            }
        }));
        const err = res.find(e => e?.error);
        if (err) {
            // throw (err.error || err);
            // Do not terminate the execution if there're extend errors, Because there can be extend timeouts as well.
            console.error(res.filter(e => e?.error))
        }
    }

    async deploy() {
        const contractIdx = this.#config.contracts.findIndex(c => c.name === this.#config.selected);
        const contract = this.#config.contracts[contractIdx];
        const ownerKeys = await HotPocket.generateKeys(contract.owner_privatekey);

        const targetCount = this.#config.contracts[contractIdx].target_nodes_count - (contract?.cluster?.length || 0);

        if (targetCount > 0) {
            console.log(`Creating ${targetCount} nodes...`);
            try {
                await this.#createCluster(contractIdx,
                    ownerKeys,
                    targetCount,
                    contract.parallel_mode);
                await this.#writeConfig();
            }
            catch (e) {
                await this.#writeConfig();
                console.error(e);
                console.error(`Cluster create failed.`);
                return;
            }

            console.log('Waiting 15 seconds until nodes are synced...');
            await sleep(15000);
        }

        if (!this.#config.contracts[contractIdx].cluster || !this.#config.contracts[contractIdx].cluster.length) {
            console.error(`Contract ${contract.name} cluster is empty.`);
            return;
        }

        if (contract.target_moments_count > 1 && this.#config.contracts[contractIdx].cluster.findIndex(c => !c.extended) >= 0) {
            console.log('Extending the cluster...');
            try {
                await this.#extendCluster(contractIdx);
                await this.#writeConfig();
            }
            catch (e) {
                await this.#writeConfig();
                console.error(e);
                console.error(`Cluster extend failed.`);
                return;
            }
        }

        const instance = this.#config.contracts[contractIdx].cluster[0];
        const instanceMgr = new ContractInstanceManager(ownerKeys, instance.pubkey, instance.ip, instance.user_port, instance.contractId, contract.bundle_path);

        console.log('Deploying the contract...');
        try {
            await instanceMgr.deployContract({
                unl: this.#config.contracts[contractIdx].cluster.map(n => n.pubkey)
            }, 60000);
        }
        catch (e) {
            console.error(`Contract ${contract.name} deployment failed with.`, e);
            return;
        }

        console.log('Successfully deployed the contract...');
    }
}

async function main() {
    const clusterMgr = new ClusterManager();
    await clusterMgr.init();
    await clusterMgr.deploy();
    await clusterMgr.terminate();
}

main().catch(console.error);