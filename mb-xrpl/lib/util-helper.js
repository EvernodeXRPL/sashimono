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

    static isSameIPV6Subnet(address1, address2) {
        const [ip1, ip1PrefixLen] = address1.split('/');
        const [ip2, ip2PrefixLen] = address2.split('/');

        if (!(ip1 && ip2 && ip1PrefixLen && ip2PrefixLen && !isNaN(ip1PrefixLen) && !isNaN(ip2PrefixLen)))
            return false;

        try {
            // This will return the normalized abbreviated subnet CIDR notation.
            const ip1Cidr = ip6addr.createCIDR(ip1, parseInt(ip1PrefixLen));
            const ip2Cidr = ip6addr.createCIDR(ip2, parseInt(ip2PrefixLen));
            
            return (ip1Cidr === ip2Cidr)
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