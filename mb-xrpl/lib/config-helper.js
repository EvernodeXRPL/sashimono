const fs = require('fs');

class ConfigHelper {
    static readConfig(configPath, secretConfigPath = null) {
        if (!fs.existsSync(configPath))
            throw `Config file does not exist at ${configPath}`;

        let config = JSON.parse(fs.readFileSync(configPath).toString());

        if (secretConfigPath) {
            if (!fs.existsSync(secretConfigPath))
                throw `Secret config file does not exist at ${secretConfigPath}`;

            const secretCfg = JSON.parse(fs.readFileSync(secretConfigPath).toString());
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

        return config;
    }

    static writeConfig(config, configPath, secretConfigPath) {
        let publicCfg = JSON.parse(JSON.stringify(config)); // Make a copy. So, referenced object won't get changed.
        const secretCfg = {
            xrpl: {
                secret: publicCfg.xrpl.secret
            }
        }
        delete publicCfg.xrpl.secret;
        fs.writeFileSync(secretConfigPath, JSON.stringify(secretCfg, null, 2), { mode: 0o600 }); // Set file permission so only current user can read/write.
        fs.writeFileSync(configPath, JSON.stringify(publicCfg, null, 2), { mode: 0o644 }); // Set file permission so only current user can read/write and others can read.
    }

    static readSashiConfig(sashiConfigPath) {
        if (!fs.existsSync(sashiConfigPath))
            throw `Sashimono config file does not exist at ${sashiConfigPath}`;

        return JSON.parse(fs.readFileSync(sashiConfigPath).toString());
    }
}

module.exports = {
    ConfigHelper
}