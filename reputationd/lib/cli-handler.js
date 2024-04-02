const { Buffer } = require('buffer');
const { exec } = require("child_process");

class CliHelper {
    static async listInstances() {
        return await this.execCommand('evernode list');
    }

    static execCommand(command) {
        return new Promise((resolve, reject) => {
            exec(command, { stdio: 'pipe' }, (err, stdout, stderr) => {
                if (err || stderr) {
                    reject(err || stderr);
                    return;
                }

                let message = Buffer.from(stdout).toString();
                resolve(JSON.parse(message.substring(0, message.length - 1))); // Skipping the \n from the result.
            });
        })
    }
}

module.exports = {
    CliHelper
}