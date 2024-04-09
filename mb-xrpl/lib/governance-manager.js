
const evernode = require('evernode-js-client');
const fs = require('fs');
const { appenv } = require('./appenv');
const { ConfigHelper } = require('./config-helper');

async function setEvernodeDefaults(network, governorAddress, rippledServer, fallbackRippledServers) {
    await evernode.Defaults.useNetwork(network || appenv.NETWORK);

    if (governorAddress)
        evernode.Defaults.set({
            governorAddress: governorAddress
        });

    if (rippledServer)
        evernode.Defaults.set({
            rippledServer: rippledServer
        });

    if (fallbackRippledServers && fallbackRippledServers.length)
        evernode.Defaults.set({
            fallbackRippledServers: fallbackRippledServers
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
        fs.writeFileSync(this.#cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 }); // Set file permission so only current user can read/write and others can read.
    }

    #validateCandidateId(candidateId) {
        if (!candidateId)
            throw `Candidate id cannot be empty.`;
        else if (candidateId.length !== 64)
            throw `Invalid candidate id.`;
        return true;
    }

    async proposeCandidate(hashFilePath, shortName, hostClient) {
        if (!hashFilePath)
            throw `Hash file param cannot be empty.`;
        else if (!fs.existsSync(hashFilePath))
            throw `Hash file ${hashFilePath} does not exist.`;
        else if (!shortName)
            throw `Short name cannot be empty.`;

        const hashes = fs.readFileSync(hashFilePath).toString();

        let candidateId = null;
        try {
            await hostClient.connect();
            candidateId = await hostClient.propose(hashes, shortName).catch(e => {
                throw (typeof e == 'object' ? (e.code || 'PROPOSE_TX_ERR') : e);
            });
        } finally {
            await hostClient.disconnect();
        }
        return candidateId;
    }

    async withdrawCandidate(candidateId, hostClient) {
        this.#validateCandidateId(candidateId);

        try {
            await hostClient.connect();

            const candidate = await hostClient.getCandidateById(candidateId);
            if (!candidate)
                throw `There's no governance candidate for the given candidate id.`;
            else if (candidate.ownerAddress !== hostClient.xrplAcc.address)
                throw `Trying to remove governance candidate which is not owned by host.`;

            await hostClient.withdraw(candidateId).catch(e => {
                throw (typeof e == 'object' ? (e.code || 'WITHDRAW_TX_ERR') : e);
            });
        } finally {
            await hostClient.disconnect();
        }
    }

    async voteCandidate(candidateId, hostClient) {
        this.#validateCandidateId(candidateId);

        // Assure only one support vote for New Hook candidate type.
        const votes = this.getVotes();
        const candidateType = evernode.StateHelpers.getCandidateType(candidateId);

        for (let key in votes) {
            if (key === candidateId)
                throw `There's already a support vote for this candidate.`;

            if (candidateType === evernode.StateHelpers.getCandidateType(key) && candidateType === evernode.EvernodeConstants.CandidateTypes.NewHook)
                throw `There's already a support vote for this candidate type. Unvote it and try again!`;
        }

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
        this.#validateCandidateId(candidateId);

        let cfg = this.getConfig();
        delete cfg.votes[candidateId];
        this.#writeConfig(cfg);
    }

    unvoteCandidate(candidateId) {
        this.#validateCandidateId(candidateId);

        let cfg = this.getConfig();
        cfg.votes[candidateId] = evernode.EvernodeConstants.CandidateVote.Reject;
        this.#writeConfig(cfg);
    }

    getVotes() {
        const cfg = this.getConfig();
        return cfg?.votes;
    }

    async getStatus(hostClient) {
        let status = this.getConfig();
        try {
            await hostClient.connect();
            const candidate = await hostClient.getCandidateByOwner();
            const dudHostCandidates = await hostClient.getDudHostCandidatesByOwner();

            if (candidate)
                status = { ...status, candidates: { hook: candidate.uniqueId } };
            if (dudHostCandidates && dudHostCandidates.length > 0)
                status.candidates = { ...(status.candidates ?? {}), dudHosts: dudHostCandidates.map(dh => dh.uniqueId) }
        } catch (e) {
            throw (typeof e == 'object' ? (e.code || 'ERROR_IN_COLLECTING_CANDIDATES') : e);
        }
        finally {
            await hostClient.disconnect();
        }
        return status;
    }

    async reportDudHost(dudHostAddress, hostClient) {
        try {
            await hostClient.connect();
            await hostClient.reportDudHost(dudHostAddress);
            const id = evernode.StateHelpers.getDudHostCandidateId(dudHostAddress);
            return id;
        } catch (e) {
            throw (typeof e == 'object' ? (e.code || 'ERROR_IN_REPORTING_DUD_HOST') : e);
        }
        finally {
            await hostClient.disconnect();
        }
    }

    getConfig() {
        return JSON.parse(fs.readFileSync(this.#cfgPath).toString());
    }

    static async handleCommand(command, ...args) {
        let hostClient = null;

        // Secret is needed for propose, withdraw, and report in order to send the transaction.
        // Root access is needed in order to access the secret config.
        // Vote and unvote need write access for the governance config.
        if ((command == 'propose' || command === 'withdraw' || command === 'vote' || command === 'unvote' || command === 'report') && process.getuid() !== 0)
            throw "Please run with root privileges (sudo).";

        // Host client is only needed for some commands.
        if (command == 'propose' || command === 'withdraw' || command === 'vote' || command === 'status' || command === 'report') {
            // Secret is needed for propose, withdraw, and report in order to send the transaction
            const sashiMBConfig = ConfigHelper.readConfig(appenv.CONFIG_PATH,
                appenv.REPUTATIOND_CONFIG_PATH, (command == 'propose' || command === 'withdraw' || command === 'report'));
            await setEvernodeDefaults(sashiMBConfig.xrpl.network, sashiMBConfig.xrpl.governorAddress, sashiMBConfig.xrpl.rippledServer, sashiMBConfig.xrpl.fallbackRippledServers);
            hostClient = new evernode.HostClient(sashiMBConfig.xrpl.address, sashiMBConfig.xrpl.secret);
        }
        const mgr = new GovernanceManager(appenv.GOVERNANCE_CONFIG_PATH);

        if (args.length === 2 && command === 'propose') {
            const id = await mgr.proposeCandidate(args[0], args[1], hostClient);
            console.log(`Successfully proposed the candidate ${id}.`);
        }
        else if (args.length === 1 && command === 'withdraw') {
            await mgr.withdrawCandidate(args[0], hostClient);
            console.log(`Successfully withdrawn the candidate ${args[0]}.`);
        }
        else if (args.length === 1 && command === 'vote') {
            await mgr.voteCandidate(args[0], hostClient);
            console.log(`Voted for candidate ${args[0]}.`);
        }
        else if (args.length === 1 && command === 'unvote') {
            mgr.clearCandidate(args[0]);
            console.log(`Rejected vote for candidate ${args[0]}.`);
        }
        else if (args.length === 0 && command === 'status') {
            const status = await mgr.getStatus(hostClient);
            console.log(JSON.stringify(status, null, 2));
        }
        else if (args.length === 1 && command === 'report') {
            const id = await mgr.reportDudHost(args[0], hostClient);
            console.log(`Successfully proposed the dud host candidate ${id}.`);
        }
        else {
            throw "Invalid args.";
        }
    }
}

module.exports = {
    GovernanceManager
}