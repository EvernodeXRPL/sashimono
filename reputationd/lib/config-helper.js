const fs = require('fs');

class ConfigHelper {
    static readConfig(configPath, secretConfigPath = null, mbXrplConfigPath = null) {
        if (!fs.existsSync(configPath))
            throw `Config file does not exist at ${configPath}`;

        let config = JSON.parse(fs.readFileSync(configPath).toString());

        if (secretConfigPath) {
            if (!fs.existsSync(secretConfigPath))
                throw `Secret config file does not exist at ${secretConfigPath}`;

            const secretCfg = JSON.parse(fs.readFileSync(secretConfigPath).toString());
            config.xrpl = { ...config.xrpl, ...secretCfg.xrpl };
        }

        if (mbXrplConfigPath && fs.existsSync(mbXrplConfigPath)) {
            let mbXrplConfig = JSON.parse(fs.readFileSync(mbXrplConfigPath).toString());
            config.xrpl.hostAddress = mbXrplConfig.xrpl.address;
            config.xrpl = {...mbXrplConfig.xrpl, ...config.xrpl}
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