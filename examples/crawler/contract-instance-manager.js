
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const bson = require('bson');
const HotPocket = require('hotpocket-js-client');

const uploadTimeout = 30000;

class ContractInstanceManager {

    #ownerPrivKeyHex;
    #instancePubKeyHex;
    #ip;
    #userPort;
    #contractId;
    #contractBundle;

    constructor(ownerPrivKeyHex, instancePubKeyHex, ip, userPort, contractId, contractBundle) {
        this.#ownerPrivKeyHex = ownerPrivKeyHex;
        this.#instancePubKeyHex = instancePubKeyHex;
        this.#ip = ip;
        this.#userPort = userPort;
        this.#contractId = contractId;
        this.#contractBundle = contractBundle;
    }

    async deployContract() {
        const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'evncrawler'));

        try {
            const hpc = await this.#getHotPocketConnection();
            await this.#uploadBundle(hpc, this.#contractBundle);
            await hpc.close();
        }
        catch (e) {
            throw e;
        }
        finally {
            await fs.rm(tmpdir, { recursive: true, force: true });
        }
    }

    async #getHotPocketConnection() {
        const server = `wss://${this.#ip}:${this.#userPort}`
        const keys = await HotPocket.generateKeys(this.#ownerPrivKeyHex);
        const hpc = await HotPocket.createClient([server], keys, {
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

    async #uploadBundle(hpc, bundleZipFile) {

        return new Promise(async (resolve, reject) => {

            const uploadTimer = setTimeout(() => reject("Upload timeout."), uploadTimeout);

            const failure = (e) => {
                clearTimeout(uploadTimer);
                reject(e);
            }
            const success = () => {
                console.log("Upload complete");
                clearTimeout(uploadTimer);
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
                    if (result.type == "uploadResult") {
                        if (result.status == "ok")
                            success();
                        else
                            failure(`Zip upload failed. reason: ${result.status}`);
                    }
                    else {
                        console.log("Unknown contract output.");
                    }
                });
            });

            const fileContent = await fs.readFile(bundleZipFile);

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