import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
// import evernode from "evernode-js-client";
const process = require('process');
// const { UserClient, XrplAccount, XrplApi, Defaults } = evernode;

const { EvernodeManager } = require("./evernode-manager");
const { ConfigManager } = require("./config-manager");
const { EvernodeService }= require('./evernode-service');
const { v4: uuidv4 } = require('uuid');


const configFile = "config.json";


// Inputs
target = process.argv[1];           // no. of instances
contract_id = process.argv[2];     //  Contract ID
roundtime;
momentCount;

configs = {};
hosts = [];
ConfigMan = new ConfigManager();
evernodeService = null;
unlList = [];
peers = [];


async function readConfigs(configFile) {
    const buf = await fs.readFile(configFile).catch(err => {
        traceLog("Config file load error.");
    });

    if (buf) {
        return JSON.parse(buf);
        // Validation
    }
}


async function createCluster() {
    hosts = evernodeService.getHosts();
    contract = configs.contracts.filter(c => c.name === configs.selected)[0];

    for (const host in hosts) {
        if(unlList.legth == 0) {
            let instance = await evernodeMan.acquireLease(host, contract.name, contract.contract_id, contract.owner_pubkey)
            unlList.push(instance.pubkey);
            peers.push();
        } 
        else {
            let result = await evernodeMan.acquireLease(host, instanceId, contract_id, ownerPubKey, unlList)
            unlList.push(result.instance.pubkey);
            peers.push();

        }
    }
}


async function main() {
    // init();
    configs = await readConfigs(configFile);
    evernodeService = new EvernodeService(configs);
    let fundAmount = "100000";   // Calculate
    await evernodeService.prepareAccounts(fundAmount);
    await createCluster();

}

main();