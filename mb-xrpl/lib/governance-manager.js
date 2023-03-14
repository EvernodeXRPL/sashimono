
const evernode = require('evernode-js-client');
const fs = require('fs');
const { appenv } = require('./appenv');
const { ConfigHelper } = require('./config-helper');

function setEvernodeDefaults(governorAddress, rippledServer, xrplApi) {
    evernode.Defaults.set({
        governorAddress: governorAddress,
        rippledServer: rippledServer,
        xrplApi: xrplApi
    });
}

class GovernanceManager {
    #cfgPath;

    constructor(cfgPath) {
        this.#cfgPath = cfgPath;
        if (!fs.existsSync(cfgPath)) {
            this.#writeConfig({
                votes: {}
            });
        }
    }

    #writeConfig(cfg) {
        fs.writeFileSync(this.#cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 }); // Set file permission so only current user can read/write.
    }

    async proposeCandidate(hashFilePath, shortName, hostClient) {
        if (!hashFilePath)
            throw `Hash file param cannot be empty.`;
        else if (!fs.existsSync(hashFilePath))
            throw `Hash file ${hashFilePath} does not exist.`;
        else if (!shortName)
            throw `Short name cannot be empty.`;

        const hashes = fs.readFileSync(hashFilePath).toString();

        try {
            await hostClient.connect();
            await hostClient.propose(hashes, shortName).catch(e => {
                let err;
                if (e.code === "tecHOOK_REJECTED" && e.hookExecutionResult) {
                    err = e.hookExecutionResult.map(o => o.message).join(', ');
                }
                throw err || e.code || 'PROPOSE_TX_ERR';
            });
        } finally {
            await hostClient.disconnect();
        }
    }

    async withdrawCandidate(candidateId, hostClient) {
        if (!candidateId)
            throw `Candidate id cannot be empty.`;

        try {
            await hostClient.connect();

            const candidate = await hostClient.getCandidateById(candidateId);
            if (!candidate)
                throw `There's no governance candidate for the given candidate id.`;
            else if (candidate.ownerAddress !== hostClient.xrplAcc.address)
                throw `Trying to remove governance candidate which is not owned by host.`;

            await hostClient.withdraw(candidateId).catch(e => {
                let err;
                if (e.code === "tecHOOK_REJECTED" && e.hookExecutionResult) {
                    err = e.hookExecutionResult.map(o => o.message).join(', ');
                }
                throw err || e.code || 'WITHDRAW_TX_ERR';
            });
        } finally {
            await hostClient.disconnect();
        }
    }

    async voteCandidate(candidateId, hostClient) {
        try {
            await hostClient.connect();

            const candidate = await hostClient.getCandidateById(candidateId);
            if (!candidate)
                throw `There's no governance candidate for the given candidate id.`;

            let cfg = this.getConfig();
            cfg.votes[candidateId] = evernode.EvernodeConstants.CandidateVote.Support;
            this.#writeConfig(cfg);
        } finally {
            await hostClient.disconnect();
        }
    }

    clearCandidate(candidateId) {
        let cfg = this.getConfig();
        delete cfg[candidateId];
        this.#writeConfig(cfg);
    }

    unvoteCandidate(candidateId) {
        let cfg = this.getConfig();
        cfg.votes[candidateId] = evernode.EvernodeConstants.CandidateVote.Reject;
        this.#writeConfig(cfg);
    }

    getVotes() {
        const cfg = this.getConfig();
        return cfg?.votes;
    }

    async printStatus(hostClient) {
        let status = this.getConfig();
        try {
            await hostClient.connect();
            const candidate = await hostClient.getCandidateByOwner();

            if (candidate)
                status = { ...status, candidate: candidate.uniqueId };
        } finally {
            await hostClient.disconnect();
        }

        console.log(JSON.stringify(status, null, 2));
    }

    getConfig() {
        return JSON.parse(fs.readFileSync(this.#cfgPath).toString());
    }

    static async handleCommand(command, ...args) {
        let hostClient;
        if (command == 'propose' || command === 'withdraw' || command === 'vote' || command === 'status') {
            const sashiMBConfig = ConfigHelper.readConfig(appenv.CONFIG_PATH, appenv.SECRET_CONFIG_PATH);
            setEvernodeDefaults(sashiMBConfig.xrpl.governorAddress, sashiMBConfig.xrpl.rippledServer);
            hostClient = new evernode.HostClient(sashiMBConfig.xrpl.address, sashiMBConfig.xrpl.secret);
        }
        const mgr = new GovernanceManager(appenv.GOVERNANCE_CONFIG_PATH);

        if (args.length === 2 && command === 'propose') {
            await mgr.proposeCandidate(args[0], args[1], hostClient);
        }
        else if (args.length === 1 && command === 'withdraw') {
            await mgr.withdrawCandidate(args[0], hostClient);
        }
        else if (args.length === 1 && command === 'vote') {
            await mgr.voteCandidate(args[0], hostClient);
        }
        else if (args.length === 1 && command === 'unvote') {
            mgr.clearCandidate(args[0]);
        }
        else if (args.length === 0 && command === 'status') {
            await mgr.printStatus(hostClient);
        }
        else {
            throw "Invalid args.";
        }
        return true;
    }
}

module.exports = {
    GovernanceManager
}