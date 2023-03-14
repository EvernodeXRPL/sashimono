
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
    #cfg;

    constructor(cfgPath) {
        this.#cfgPath = cfgPath;
        if (!fs.existsSync(cfgPath)) {
            this.#cfg = {
                candidate: '',
                votes: {}
            };
            this.#persistGovernanceConfig();
        }
        else {
            this.#cfg = JSON.parse(fs.readFileSync(this.#cfgPath).toString());
        }
    }

    #getSashiMBConfig() {
        return ConfigHelper.readConfig(appenv.CONFIG_PATH, appenv.SECRET_CONFIG_PATH);
    }

    #persistGovernanceConfig() {
        fs.writeFileSync(this.#cfgPath, JSON.stringify(this.#cfg, null, 2), { mode: 0o600 }); // Set file permission so only current user can read/write.
    }

    async proposeCandidate(hashFilePath, shortName) {
        if (!hashFilePath)
            throw `Hash file param cannot be empty.`;
        else if (!fs.existsSync(hashFilePath))
            throw `Hash file ${hashFilePath} does not exist.`;
        else if (!shortName)
            throw `Short name cannot be empty.`;

        const hashes = fs.readFileSync(hashFilePath).toString();

        const acc = this.#getSashiMBConfig().xrpl;
        setEvernodeDefaults(acc.governorAddress, acc.rippledServer);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);

        try {
            await hostClient.connect();
            const id = await hostClient.propose(hashes, shortName);
            this.#cfg.candidate = id;
            this.#persistGovernanceConfig();
        } finally {
            await hostClient.disconnect();
        }
    }

    async withdrawCandidate(candidateId) {
        if (!candidateId)
            throw `Candidate id cannot be empty.`;

        const acc = this.#getSashiMBConfig().xrpl;
        setEvernodeDefaults(acc.governorAddress, acc.rippledServer);

        const hostClient = new evernode.HostClient(acc.address, acc.secret);

        try {
            await hostClient.connect();
            await hostClient.withdraw(candidateId);
            this.#cfg.candidate = '';
            this.#persistGovernanceConfig();
        } finally {
            await hostClient.disconnect();
        }
    }

    voteCandidate(candidateId) {
        this.#cfg.votes[candidateId] = evernode.EvernodeConstants.CandidateVote.Support;
        this.#persistGovernanceConfig();
    }

    clearCandidate(candidateId) {
        delete this.#cfg[candidateId];
        this.#persistGovernanceConfig();
    }

    unvoteCandidate(candidateId) {
        this.#cfg.votes[candidateId] = evernode.EvernodeConstants.CandidateVote.Reject;
        this.#persistGovernanceConfig();
    }

    getVotes() {
        const cfg = JSON.parse(fs.readFileSync(this.#cfgPath).toString());
        return cfg?.votes;
    }
}

module.exports = {
    GovernanceManager
}