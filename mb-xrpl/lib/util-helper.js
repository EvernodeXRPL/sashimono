const ip6addr = require('ip6addr');

class UtilHelper {

    static generateIPV6Address(subnetStr, incrementor) {
        const subnet = ip6addr.createCIDR(subnetStr);
        const firstIP = subnet.first().toString({ zeroElide: false, zeroPad: true }).toUpperCase();
        const ipv6BigInt = BigInt("0x" + firstIP.replace(/:/g, ""));

        const resultBigInt = ipv6BigInt + BigInt(incrementor);
        const maxIPv6Value = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
        const resultIPv6BigInt = resultBigInt % (maxIPv6Value + BigInt(1));

        const resultIPv6 = resultIPv6BigInt.toString(16).toUpperCase().match(/.{1,4}/g).join(":");

        if (subnet.contains(resultIPv6))
            return resultIPv6;

        return null;
    }

    static isInIPV6Subnet(subnet, ip) {
        const [ip1, ip1PrefixLen] = subnet.split('/');

        try {
            const subnetCidr = ip6addr.createCIDR(ip1, parseInt(ip1PrefixLen));
            const ipCidr = ip6addr.createCIDR(ip, parseInt(ip1PrefixLen));

            if (subnetCidr.first().compare(ipCidr.first()) <= 0 &&
                subnetCidr.last().compare(ipCidr.last()) >= 0) {
                return true;
            }
            return false;
        }
        catch {
            // Silent catch so that we don't log exceptions to console.
            // This will be treated as ip validation failure.
            return false;
        }
    }
}

module.exports = {
    UtilHelper
}