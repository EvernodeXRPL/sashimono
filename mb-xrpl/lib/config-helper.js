const fs = require('fs');

class ConfigHelper {
    static readConfig(configPath, reputationDConfigPath = null, readSecret = false) {
        if (!fs.existsSync(configPath))
            throw `Config file does not exist at ${configPath}`;

        let config = JSON.parse(fs.readFileSync(configPath).toString());

        if (readSecret) {
            if (!fs.existsSync(config.xrpl.secretPath))
                throw `Secret config file does not exist at ${config.xrpl.secretPath}`;

            const secretCfg = JSON.parse(fs.readFileSync(config.xrpl.secretPath).toString());
            config.xrpl = { ...config.xrpl, ...secretCfg.xrpl };
        }

        // Validate lease amount.
        if (config.xrpl.leaseAmount && typeof config.xrpl.leaseAmount === 'string') {
            config.xrpl.leaseAmount = parseFloat(config.xrpl.leaseAmount);
            if (isNaN(config.xrpl.leaseAmount))
                throw "Lease amount should be a numerical value.";
        }

        if (config.xrpl.leaseAmount && config.xrpl.leaseAmount < 0)
            throw "Lease amount should be a positive value";

        if (reputationDConfigPath && fs.existsSync(reputationDConfigPath)) {
            const reputationDConfig = JSON.parse(fs.readFileSync(reputationDConfigPath).toString());
            config.xrpl.reputationAddress = reputationDConfig.xrpl.address;

            if (readSecret) {
                if (!fs.existsSync(reputationDConfig.xrpl.secretPath))
                    throw `Secret config file does not exist at ${reputationDConfig.xrpl.secretPath}`;

                const reputationDSecretCfg = JSON.parse(fs.readFileSync(reputationDConfig.xrpl.secretPath).toString());
                config.xrpl.reputationSecret = reputationDSecretCfg.xrpl.secret;
            }

            config.xrpl = { ...reputationDConfig.xrpl, ...config.xrpl }
        }

        return config;
    }

    static writeConfig(config, configPath) {
        let publicCfg = JSON.parse(JSON.stringify(config)); // Make a copy. So, referenced object won't get changed.
        if ('secret' in publicCfg.xrpl)
            delete publicCfg.xrpl.secret;
        fs.writeFileSync(configPath, JSON.stringify(publicCfg, null, 2), { mode: 0o644 }); // Set file permission so only current user can read/write and others can read.
    }

    static readSashiConfig(sashiConfigPath) {
        if (!fs.existsSync(sashiConfigPath))
            throw `Sashimono configuration file does not exist at ${sashiConfigPath}`;

        return JSON.parse(fs.readFileSync(sashiConfigPath).toString());
    }
}

module.exports = {
    ConfigHelper
}