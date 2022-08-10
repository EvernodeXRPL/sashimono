const fs = require('fs').promises;
const { PathManager } = require('./path-manager');

class ConfigManager {
    #config = {};
    #changed = false;

    constructor() {
        this.confFile = PathManager.get("config.json");
    }

    init() {
        return new Promise(async (resolve) => {
            const buf = await fs.readFile(this.confFile).catch(err => {
                traceLog("Config file load error.");
                resolve(false);
            });

            if (buf) {
                this.#config = JSON.parse(buf);

                const { target, registryAddress, ownerPubKey } = this.#config;
                const valid = (target > 0 &&
                    registryAddress && registryAddress.length > 0 &&
                    ownerPubKey && ownerPubKey.length > 0)
                resolve(valid);
            }
        })
    }

    // Currently selected target size.
    target() {
        return this.#config.target;
    }

    tenantAddress() {
        return "rEM7SuX4jQKD2LHLqGpLxDmYjvQHzspAst";
    }

    tenantSecret() {
        return "shrfnbk9voPwH4FfTP7vCKVPa97Yw";
    }

    registryAddress() {
        return this.#config.registryAddress;
    }

    // Contract owner public key.
    ownerPubKey() {
        return this.#config.ownerPubKey;
    }

    // Updates the current target size.
    setTargetSize(newSize) {
        if (newSize <= 0)
            throw "Target must be greater than 0.";

        if (newSize !== this.#config.target) {
            traceLog(`Updating target size from ${this.#config.target} to ${newSize}`);
            this.#config.target = newSize;
            this.#changed = true;
        }
    }

    hasChanges() {
        return this.#changed;
    }

    async save() {
        if (this.#changed) {
            await fs.writeFile(this.confFile, JSON.stringify(this.#config, null, 2));
        }
    }
}

module.exports = {
    ConfigManager
}