const ip6addr = require('ip6addr');

class UtilHelper {

    static generateIPV6Addresses(subnetStr, addressCount) {

        // Incrementally assign IPv6 addresses
        const generatedIPs = [];

        for (let i = 0; generatedIPs.length < addressCount; i++) {
            const generatedIP = this.generateValidIPV6Address(subnetStr, (i > 0) ? generatedIPs[i - 1] : null);
            if (generatedIP) {
                generatedIPs.push(generatedIP);
            }
        }

        return generatedIPs;
    }

    static generateValidIPV6Address(subnetStr, offsetIP = null, isBelowOffset = false) {
        // Define your IPv6 subnet
        const subnet = ip6addr.createCIDR(subnetStr);

        if (offsetIP && !subnet.contains(offsetIP))
            throw "Invalid offset IP Address."

        if (offsetIP) {
            const newAddressBuf = Buffer.from(offsetIP.split(':').map(v => {
                const bytes = [];
                for (let i = 0; i < v.length; i += 2) {
                    bytes.push(parseInt(v.substr(i, 2), 16));
                }
                return bytes;
            }).flat());

            let j = newAddressBuf.length - 1;
            while (j >= 0) {
                if (isBelowOffset) {
                    if (newAddressBuf[j] - 1 < 0) {
                        newAddressBuf[j] = parseInt("0xFF", 16);
                        j--;
                        continue;
                    }
                    else {
                        newAddressBuf[j]--;
                        break;
                    }

                } else {
                    if (newAddressBuf[j] + 1 > parseInt("0xFF", 16)) {
                        newAddressBuf[j] = 0;
                        j--;
                        continue;
                    }
                    else {
                        newAddressBuf[j]++;
                        break;
                    }
                }
            }

            const ipString = newAddressBuf.toString('hex').toUpperCase().replace(/(.{4})(?!$)/g, "$1:");
            if (subnet.contains(ipString)) {
                return ipString;
            }
        } else
            return subnet.first().toBuffer().toString('hex').toUpperCase().replace(/(.{4})(?!$)/g, "$1:");

    }
}

module.exports = {
    UtilHelper
}