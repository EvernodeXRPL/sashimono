const { Buffer } = require('buffer');
const { exec } = require("child_process");

class SashiCLI {

    #waiting = false;

    constructor(cliPath, env = {}) {
        this.cliPath = cliPath;
        this.env = env;
    }

    async createInstance(containerName, requirements) {
        if (!requirements.type)
            requirements.type = 'create';
        requirements.container_name = containerName;

        const res = await this.execSashiCli(requirements);
        if (res.type === 'create_error')
            throw res;

        return res;
    }

    async destroyInstance(containerName) {
        const msg = {
            type: 'destroy',
            container_name: containerName
        };
        const res = await this.execSashiCli(msg);
        if ((res.content && typeof res.content == 'string' && res.content.endsWith("error")) ||
            res.type && typeof res.type == 'string' && res.type.endsWith("error"))
            throw res;

        return res;
    }

    wait() {
        return new Promise(resolve => {
            // Wait until incompleted sashi cli requests are completed..
            const waitCheck = setInterval(() => {
                if (!this.#waiting) {
                    clearInterval(waitCheck);
                    resolve(true);
                }
            }, 100);
        })
    }

    execSashiCli(msg) {
        this.#waiting = true;
        return new Promise((resolve, reject) => {
            let command = (Object.keys(this.env).length > 0 ? `${Object.entries(this.env).map(e => `${e[0]}=${e[1]}`)} ` : '') + `${this.cliPath} json -m '${JSON.stringify(msg)}'`;

            if (msg.type === "create") {
                command = `DEV_MODE=1 ${command}`;
            }

            exec(command, { stdio: 'pipe' }, (err, stdout, stderr) => {
                this.#waiting = false;

                if (err || stderr) {
                    reject(err || stderr);
                    return;
                }

                let message = Buffer.from(stdout).toString();
                resolve(JSON.parse(message.substring(0, message.length - 1))); // Skipping the \n from the result.
            });
        })
    }

    checkStatus() {
        this.#waiting = true;
        return new Promise((resolve, reject) => {
            exec(`${this.cliPath} status`, { stdio: 'pipe' }, (err, stdout, stderr) => {
                this.#waiting = false;

                if (err || stderr) {
                    reject(err || stderr);
                    return;
                }

                let message = Buffer.from(stdout).toString();
                message = message.substring(0, message.length - 1); // Skipping the \n from the result.
                console.log(`Sashi CLI : ${message}`);
                resolve(message);
            });
        });
    }
}

module.exports = {
    SashiCLI
}