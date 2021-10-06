import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import evernode from "evernode-js-client";
const { EvernodeClient, XrplAccount, RippleAPIWrapper } = evernode;

const REDEEM_AMOUNT = 18000; // 18000 Moments ~ 60days

const configFile = "config.json";
const config = JSON.parse(fs.readFileSync(configFile));
const currentContract = config.contracts.filter(c => c.name === config.selected)[0];
if (!currentContract)
    throw "Invalid contract selected.";

const userAddr = config.xrpl.userAddress;
const userSecret = config.xrpl.userSecret;
let rippleAPI = null;
let evernodeClient = null;

async function createInstance(host, hostId, elem, peers, unl) {

    if (Object.keys(elem).length > 0) {
        console.log(`Instance in host ${hostId} already created.`)
        return;
    }

    console.log(`-------Host ${hostId}-------`);

    const acc = await getHostAccountData(host);
    await transferHostingTokens(acc.token, acc.address, acc.secret);

    // Copy defined config from config.json to instance requirements config.
    const config = JSON.parse(JSON.stringify(currentContract.config)) || {};
    if (unl)
        config.contract = { ...config.contract, unl: unl };
    if (peers)
        config.mesh = { ...config.mesh, known_peers: peers };

    // Redeem
    console.log(`Redeeming ${acc.token}-${acc.address}...`);
    const instanceInfo = await evernodeClient.redeem(acc.token, acc.address, REDEEM_AMOUNT, {
        image: currentContract.docker.image,
        contract_id: currentContract.contract_id,
        owner_pubkey: currentContract.owner_pubkey,
        config: config
    }).catch(err => console.log(err));

    if (instanceInfo) {
        for (var k in instanceInfo)
            elem[k] = instanceInfo[k];

        console.log(`Created instance in host ${hostId}.`);
        saveConfig();
        return true;
    }
    else {
        console.log(`Instance creation failed in host ${hostId}.`);
        return false;
    }
}

async function createInstancesSequentially() {
    await initHosts();
    await createConnections();

    let peers = null, unl = null;

    let idx = 1;
    for (const [host, elem] of Object.entries(currentContract.hosts)) {
        if (await createInstance(host, idx++, elem, peers, unl) === false)
            return;

        if (!unl)
            unl = [elem.pubkey]; // Insert first instance's pubkey into all other instance's unl.

        if (!peers)
            peers = [];
        peers.push(`${host}:${elem.peer_port}`);
    }
}

async function createInstancesParallely(peerPort) {
    await initHosts();
    await createConnections();

    // Create first instace and then create all other instances parallely assuming they all have the same peer port.

    let unl = null;
    const peers = Object.keys(currentContract.hosts).map(h => `${h}:${peerPort}`);
    const tasks = [];

    let idx = 1;
    for (const [host, elem] of Object.entries(currentContract.hosts)) {

        if (!unl) {
            if (await createInstance(host, idx++, elem, peers, null) === false)
                return;

            unl = [elem.pubkey]; // Insert first instance's pubkey into all other instance's unl.
        }
        else {
            // Add to parallel creation tasks.
            tasks.push(createInstance(host, idx++, elem, peers, unl));
        }
    }

    await Promise.all(tasks);
}

async function initHosts() {
    if (Object.keys(currentContract.hosts).length > 0)
        return;

    const ips = await getVultrHosts(currentContract.vultr_group);
    ips.forEach(ip => currentContract.hosts[ip] = {});
    saveConfig();
}

function saveConfig() {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 4));
}

function execSsh(host, command) {
    return new Promise(resolve => {
        const cmd = `ssh -o StrictHostKeychecking=no root@${host} ${command}`;
        exec(cmd, (err, stdout, stderr) => {
            resolve(stdout);
        });
    })
}

async function getHostAccountData(host) {
    const output = await execSsh(host, "cat /etc/sashimono/mb-xrpl/mb-xrpl.cfg");
    if (!output || output.trim() === "") {
        console.log("ERROR: No output from mb-xrpl config read.")
        return;
    }

    const conf = JSON.parse(output);
    return {
        address: conf.xrpl.address,
        secret: conf.xrpl.secret,
        token: conf.xrpl.token
    }
}

// Get hosting tokens from host account to user account.
async function transferHostingTokens(token, hostAddr, hostSecret) {

    console.log(`Checking user's ${token} balance...`);

    const userAcc = new XrplAccount(rippleAPI, userAddr, userSecret);
    const lines = await userAcc.getTrustLines(token, hostAddr);
    if (lines.length === 0) {
        console.log(`Transfering ${token} to user...`);
        const trustRes = await userAcc.createTrustLine(token, hostAddr, 9999999);
        if (!trustRes)
            return false;

        const hostAcc = new XrplAccount(rippleAPI, hostAddr, hostSecret);
        const payRes = await hostAcc.makePayment(userAddr, 9999999, token, hostAddr);
        if (!payRes)
            return false;

        console.log(`Transfering of ${token} complete.`);
    }

    return true;
}

function getVultrHosts(group) {

    return new Promise(async (resolve) => {

        if (!group || group.trim().length === 0)
            resolve([]);

        const resp = await fetch(`https://api.vultr.com/v2/instances?tag=${group}`, {
            method: 'GET',
            headers: { "Authorization": `Bearer ${config.vultr.api_key}` }
        });

        const vms = (await resp.json()).instances;
        if (!vms) {
            console.log("Failed to get vultr instances.");
            resolve([]);
            return;
        }

        const ips = vms.sort((a, b) => (a.label < b.label) ? -1 : 1).map(i => i.main_ip);
        resolve(ips);
    })
}

async function createConnections() {
    rippleAPI = new RippleAPIWrapper();
    await rippleAPI.connect();

    evernodeClient = new EvernodeClient(userAddr, userSecret, { rippleAPI: rippleAPI });
    await evernodeClient.connect();
}

async function main() {
    var args = process.argv.slice(2);

    const mode = args[0];
    if (mode === "create") {
        if (args.length === 1) {
            await createInstancesSequentially();
        }
        else {
            console.log("Invalid args for 'create'.");
        }
    }
    else if (mode === "createall") {
        const peerPort = parseInt(args[1]);
        if (!isNaN(peerPort))
            await createInstancesParallely(peerPort);
        else
            console.log("Specify peer port for 'createall'.");
    }
    else {
        console.log("Specifiy args: create | createall <peerport>")
    }

    if (rippleAPI)
        await rippleAPI.disconnect();
}

main();