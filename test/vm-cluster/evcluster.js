const { exec } = require("child_process");
const fs = require("fs");
const { XrplAccount, RippleAPIWarpper } = require('./ripple-wrapper');

const userAddr = "raFCgMEj2P7dEwVwDQD81Jj5mLKUWmxpX9";
const userSecret = "snbqbnYaD5Kqc82nfKWo3dMieQvG9";
const hookAddr = "rwGLw5uSGYm2couHZnrbCDKaQZQByvamj8";
const configFile = "config.json";

const config = JSON.parse(fs.readFileSync(configFile));
const currentContract = config.contracts.filter(config.selected)[0];
if (!currentContract)
    throw "Invalid contract selected.";

async function createInstance(host, useContractId, useImage, useConfig, elem) {

    if (Object.keys(elem).length > 0)
        return;

    const acc = await getHostAccountData(host);
    await transferHostingTokens(acc.token, acc.address, acc.secret);

    // Send redeem req.
    // Get redeem resp.
    const resp = "{}";
    const inst = JSON.parse(resp);
    for (var k in inst)
        elem[k] = inst[k];
}

async function initHosts() {
    if (Object.keys(currentContract.hosts).length > 0)
        return;

    const ips = await getVultrHosts(currentContract.vultr_group);
    ips.forEach(ip => currentContract.hosts[ip] = {});
    saveConfig();
}

async function createInstancesSequentially() {
    await initHosts();
}

function saveConfig() {
    fs.writeFileSync(configFile, JSON.stringify(config));
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
async function transferHostingTokens(currency, hostAddr, hostSecret) {
    const ripplAPI = new RippleAPIWarpper(rippleServer);
    await ripplAPI.connect();

    const hookAcc = new XrplAccount(ripplAPI, hostAddr, hostSecret);
    const payRes = await hookAcc.makePayment(userAddr, 99999, currency, hostAddr);

    await ripplAPI.disconnect();
    return payRes;
}

function getVultrHosts(group) {

    return new Promise(async (resolve) => {

        if (!group || group.trim().length == 0)
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