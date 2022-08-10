const fs = require('fs').promises;

class PathManager {

    static #datadir = "./";

    static async init(datadir) {

        if (!datadir)
            return;

        PathManager.#datadir = datadir;
        if (!PathManager.#datadir.endsWith("/"))
            PathManager.#datadir += "/";

        if (!await fs.stat(PathManager.#datadir).catch(err => { })) {
            traceLog("Creating data dir: " + PathManager.#datadir);
            await fs.mkdir(PathManager.#datadir);
        }
    }

    static get(target) {
        return PathManager.#datadir + target;
    }
}

module.exports = {
    PathManager
}