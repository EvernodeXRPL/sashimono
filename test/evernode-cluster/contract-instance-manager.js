
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const bson = require('bson');
const HotPocket = require('hotpocket-js-client');
const { execSync } = require('child_process');

const UPLOAD_TIMEOUT = 30000;

class ContractInstanceManager {

    #ownerKeys;
    #instancePubKeyHex;
    #ip;
    #userPort;
    #contractId;
    #contractBundle;
    #tmpdir;

    constructor(ownerKeys, instancePubKeyHex, ip, userPort, contractId, contractBundle) {
        this.#ownerKeys = ownerKeys;
        this.#instancePubKeyHex = instancePubKeyHex;
        this.#ip = ip;
        this.#userPort = userPort;
        this.#contractId = contractId;
        this.#contractBundle = contractBundle;
    }

    async deployContract(config, uploadTimeout = null) {
        this.#tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'evncluster'));

        try {
            const hpc = await this.#getHotPocketConnection();
            await this.#uploadBundle(hpc, this.#contractBundle, config, uploadTimeout);
            await hpc.close();
        }
        catch (e) {
            throw e;
        }
        finally {
            await fs.rm(this.#tmpdir, { recursive: true, force: true });
        }
    }

    async #getHotPocketConnection() {
        const server = `wss://${this.#ip}:${this.#userPort}`
        const hpc = await HotPocket.createClient([server], this.#ownerKeys, {
            contractId: this.#contractId,
            trustedServerKeys: [this.#instancePubKeyHex],
            protocol: HotPocket.protocols.bson
        });

        // Establish HotPocket connection.
        if (!await hpc.connect()) {
            throw `${server} connection failed.`
        }
        return hpc;
    }

    async #uploadBundle(hpc, bundleZipFile, config, uploadTimeout = null) {

        return new Promise(async (resolve, reject) => {

            const uploadTimer = setTimeout(() => {
                clearTimeout(uploadTimer);
                hpc.clear(HotPocket.events.contractOutput);
                reject("Upload timeout.");
            }, uploadTimeout || UPLOAD_TIMEOUT);

            const failure = (e) => {
                clearTimeout(uploadTimer);
                hpc.clear(HotPocket.events.contractOutput);
                reject(e);
            }
            const success = () => {
                clearTimeout(uploadTimer);
                console.log("Upload complete");
                resolve();
            }

            // This will get fired when contract sends an output.
            hpc.on(HotPocket.events.contractOutput, (r) => {

                r.outputs.forEach(output => {
                    let result;
                    try {
                        result = bson.deserialize(output);
                    }
                    catch (e) {
                        failure(e);
                    }
                    if (result?.type == "uploadResult") {
                        if (result.status == "ok")
                            success();
                        else
                            failure(`Zip upload failed. reason: ${result.status}`);
                    }
                    else {
                        console.log("Unknown contract output.", result);
                    }
                });
            });

            const updateConfig = (target, source) => {
                for (const [key, value] of Object.entries(source)) {
                    if (typeof value !== 'object' && target.hasOwnProperty(key))
                        updateConfig(target[key], value);
                    else
                        target[key] = value;
                }
            }

            const bundleDir = `${this.#tmpdir}/bundle`;
            const bundlePath = `${bundleDir}/bundle.zip`;
            await fs.mkdir(bundleDir);

            // Update the config file in the bundle if Config updates are received.
            if (config) {
                execSync(`unzip -o ${bundleZipFile} -d ${bundleDir}/`);

                const configFile = `${bundleDir}/contract.config`;
                const buf = await fs.readFile(configFile);
                let readConfig = JSON.parse(buf);
                updateConfig(readConfig, config);
                await fs.writeFile(configFile, JSON.stringify(readConfig, null, 2));

                execSync(`cd ${bundleDir} && zip -r ${bundlePath} ./*`);
            }
            else {
                await copyFileSync(bundleZipFile, `${bundleDir}/`);
            }

            const fileContent = await fs.readFile(bundlePath);

            await fs.rm(bundleDir, { recursive: true, force: true });

            console.log("Uploading");
            const input = await hpc.submitContractInput(bson.serialize({
                type: "upload",
                content: fileContent
            }));

            const submission = await input.submissionStatus;
            console.log(submission.status);
            if (submission.status != "accepted")
                failure("Upload submission failed. reason: " + submission.reason);
        })
    }
}

module.exports = {
    ContractInstanceManager
}