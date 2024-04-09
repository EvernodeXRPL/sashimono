const fs = require('fs');

class ConfigHelper {
    static readConfig(configPath, mbXrplConfigPath = null, readSecret = false) {
        if (!fs.existsSync(configPath))
            throw `Config file does not exist at ${configPath}`;

        let config = JSON.parse(fs.readFileSync(configPath).toString());

        if (readSecret) {
            if (!fs.existsSync(config.xrpl.secretPath))
                throw `Secret config file does not exist at ${config.xrpl.secretPath}`;

            const secretCfg = JSON.parse(fs.readFileSync(config.xrpl.secretPath).toString());
            config.xrpl = { ...config.xrpl, ...secretCfg.xrpl };
        }

        if (mbXrplConfigPath && fs.existsSync(mbXrplConfigPath)) {
            const mbXrplConfig = JSON.parse(fs.readFileSync(mbXrplConfigPath).toString());
            config.xrpl.hostAddress = mbXrplConfig.xrpl.address;

            if (readSecret) {
                if (!fs.existsSync(mbXrplConfig.xrpl.secretPath))
                    throw `Secret config file does not exist at ${mbXrplConfig.xrpl.secretPath}`;

                const mbXrplSecretCfg = JSON.parse(fs.readFileSync(mbXrplConfig.xrpl.secretPath).toString());
                config.xrpl.hostSecret = mbXrplSecretCfg.xrpl.secret;
            }

            config.xrpl = { ...mbXrplConfig.xrpl, ...config.xrpl }
        }

        return config;
    }

    static writeConfig(config, configPath) {
        let publicCfg = JSON.parse(JSON.stringify(config)); // Make a copy. So, referenced object won't get changed.
        if ('secret' in publicCfg.xrpl)
            delete publicCfg.xrpl.secret;
        fs.writeFileSync(configPath, JSON.stringify(publicCfg, null, 2), { mode: 0o644 }); // Set file permission so only current user can read/write and others can read.
    }
}

module.exports = {
    ConfigHelper
}