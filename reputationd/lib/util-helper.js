const archiver = require('archiver');
const fs = require('fs');
const os = require('os');
const HotPocket = require('hotpocket-js-client');
const { execSync } = require('child_process');
const path = require('path');

const PREREQ_SCRIPT_CONTENT = `#!/bin/bash\n` +
    `echo "Prerequisite installer script"\n` +
    `exit 0`

const CONSTANTS = {
    contractCfgFile: "contract.config",
    prerequisiteInstaller: "install.sh",
    hpCfgOverrideFile: "hp.cfg.override",
};

class FsHelper {
    static async archiveDirectory(sourcePath, destinationPath = null) {
        return new Promise((resolve, reject) => {
            if (!sourcePath)
                reject("Invalid path was provided.");

            // Create a file to stream archive data to
            const target = (destinationPath) ? `${destinationPath}/bundle.zip` : `${sourcePath}/bundle.zip`
            const output = fs.createWriteStream(target);
            const archive = archiver('zip', {
                zlib: { level: 9 }
            });

            // Callbacks
            output.on('close', () => {
                resolve(target);
            });

            archive.on('error', (err) => {
                reject(err);
            });

            // Pipe and append files
            archive.pipe(output);
            archive.directory(sourcePath, false);

            // Finalize
            archive.finalize();
        });
    }
}

class ContractHelper {
    static async prepareContractBundle(contractUrl, hpOverrideCfg) {
        const contractPrepPath = fs.mkdtempSync(path.join(os.tmpdir(), 'reputation-bundle-'));
        const hpCfgOverridePath = path.resolve(contractPrepPath, CONSTANTS.hpCfgOverrideFile);
        const prerequisiteInstaller = path.resolve(contractPrepPath, CONSTANTS.prerequisiteInstaller);

        // Download content inside contract directory;
        execSync(`curl --silent -L ${contractUrl} --output ${contractPrepPath}/reputation-contract.tgz && 
        tar zxf ${contractPrepPath}/reputation-contract.tgz -C ${contractPrepPath}/ --strip-components=1 && 
        rm ${contractPrepPath}/reputation-contract.tgz`);
        console.log("Placed contract content.");

        // Write hp.cfg.override file content.
        fs.writeFileSync(hpCfgOverridePath, JSON.stringify(hpOverrideCfg, null, 4));
        console.log(`Prepared ${CONSTANTS.hpCfgOverrideFile} file.`);

        // Add prerequisite install script.
        fs.writeFileSync(prerequisiteInstaller, PREREQ_SCRIPT_CONTENT, null);

        // Change permission  pre-requisite installer.
        fs.chmodSync(prerequisiteInstaller, 0o755);
        console.log("Added prerequisite installer script.");

        const bundleTargetPath = fs.mkdtempSync(path.join(os.tmpdir(), 'reputation-bundle-target-'));

        return await FsHelper.archiveDirectory(contractPrepPath, bundleTargetPath);
    }
}

class CommonHelper {
    static async generateKeys(privateKey = null, format = 'hex') {
        const keys = await HotPocket.generateKeys(privateKey);
        return format === 'hex' ? {
            privateKey: Buffer.from(keys.privateKey).toString('hex'),
            publicKey: Buffer.from(keys.publicKey).toString('hex')
        } : keys;
    }
}

module.exports = {
    FsHelper,
    ContractHelper,
    CommonHelper
}