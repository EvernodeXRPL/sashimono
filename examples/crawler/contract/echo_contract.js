const HotPocket = require("hotpocket-nodejs-contract");
const fs = require('fs');

const exectsFile = "exects.txt";
const maxFileRead = 3 * 1024 * 1024;

function getFileData() {
    // Read entire file to memory (intentional).
    let data = fs.readFileSync("exects.txt").toString();

    // Limit max file data returned.
    if (data.length > maxFileRead) {
        data = data.substring(data.length - maxFileRead);
    }

    return data;
}

// HP smart contract is defined as a function which takes HP ExecutionContext as an argument.
// HP considers execution as complete, when this function completes and all the NPL message callbacks are complete.
const echoContract = async (ctx) => {

    // We just save execution timestamp as an example state file change.
    if (!ctx.readonly) {
        fs.appendFileSync(exectsFile, "ts:" + ctx.timestamp + "\n");

        const stats = fs.statSync(exectsFile);
        if (stats.size > 300 * 1024 * 1024) // If more than 300 MB, empty the file.
            fs.truncateSync(exectsFile);
    }

    // Collection of per-user promises to wait for. Each promise completes when inputs for that user is processed.
    const userHandlers = [];

    for (const user of ctx.users.list()) {

        // This user's hex pubkey can be accessed from 'user.pubKey'

        // For each user we add a promise to list of promises.
        userHandlers.push(new Promise(async (resolve) => {

            // The contract need to ensure that all outputs for a particular user is emitted
            // in deterministic order. Hence, we are processing all inputs for each user sequentially.
            for (const input of user.inputs) {

                const buf = await ctx.users.read(input);
                const msg = buf.toString();

                const output = (msg == "ts") ? getFileData() : ("Echoing: " + msg);
                await user.send(output);

            }

            // The promise gets completed when all inputs for this user are processed.
            resolve();
        }));
    }

    // Wait until all user promises are complete.
    await Promise.all(userHandlers);
}

const hpc = new HotPocket.Contract();
hpc.init(echoContract);