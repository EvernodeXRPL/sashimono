const fs = require('fs').promises;

async function process() {
    const buf = await fs.readFile('log.json').catch(console.error);
    const logConf = JSON.parse(buf);
    let output = [];
    let blacklist = [];
    let nooffer = [];
    let created = [];
    let preferred = [];
    for (const [key, value] of Object.entries(logConf)) {
        if (value.errors.length || value.count === 0) {
            output.push({
                key: key,
                errors: value.errors.length ? [... new Set(value.errors)] : ['Not Picked']
            });
            if (value.errors.find(e => e != 'NO_OFFER'))
                blacklist.push(key);
            else
                nooffer.push(key)
        }
        else {
            created.push(key);
        }
    }
    output.sort((a, b) => a.errors[0].localeCompare(b.errors[0]));

    const logbuf = await fs.readFile('hp.log').catch(console.error);
    const lines = logbuf.toString().split('\n');
    const configbuf = await fs.readFile('config.json').catch(console.error);
    const config = JSON.parse(configbuf)
    let times = [];
    for (const line of lines.filter(l => l.includes('frm:') && l.includes('ms') && l.includes('<'))) {
        let data = line.split('frm:')[1];
        data = data.slice(0, data.length - 3);
        data = data.split('<');
        let host = {};
        if (data[0] == 'self')
            host = config.contracts[0].cluster[0];
        else
            host = config.contracts[0].cluster.find(i => i.pubkey.slice(2, 10) == data[0]);
        const index = times.findIndex(h => h.key == host.host);
        if (index < 0) {
            times.push({
                key: host.host,
                time: parseInt(data[1])
            })
        }
        else if (times[index].time > parseInt(data[1])) {
            times.splice(index, 1);
            times.push({
                key: host.host,
                time: parseInt(data[1])
            })
        }
    }
    for (const p of created) {
        const found = times.find(h => h.key == p);
        if (!found) {
            times.push({
                key: p,
                time: 100000000000000
            })
        }
        else if (found.time < 150) {
            preferred.push(p);
        }
    }
    times.sort((a, b) => (a.time > b.time) ? 1 : ((b.time > a.time) ? -1 : 0));

    output.push({
        blacklist: blacklist,
        nooffer: nooffer,
        created: created,
        preferred: preferred,
        times: times,
        totalhostcount: Object.keys(logConf).length,
        checkedhostcount: nooffer.length + created.length + blacklist.length
    })
    await fs.writeFile('summary.json', JSON.stringify(output, null, 2)).catch(console.error);

}

process().catch(console.error);