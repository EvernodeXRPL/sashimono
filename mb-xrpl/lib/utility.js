class Utility {
    static getTOSHash() {
        const buf = Buffer.from('BECF974A2C48C21F39046C1121E5DF7BD55648E1005172868CD5738C23E3C073', 'hex');
        buf.writeUInt32BE(Math.floor((Math.random() * 100) + 1));
        return buf.toString('hex');
    }
}

module.exports = {
    Utility
}