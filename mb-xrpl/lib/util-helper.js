const ip6addr = require('ip6addr');

class UtilHelper {

    static generateIPV6Address(subnetStr, incrementor) {
        const subnet = ip6addr.createCIDR(subnetStr);
        const firstIP = subnet.first().toString({ zeroElide: false, zeroPad: true }).toUpperCase();
        console.log(firstIP)
        const ipv6BigInt = BigInt("0x" + firstIP.replace(/:/g, ""));

        const resultBigInt = ipv6BigInt + BigInt(incrementor);
        const maxIPv6Value = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
        const resultIPv6BigInt = resultBigInt % (maxIPv6Value + BigInt(1));

        const resultIPv6 = resultIPv6BigInt.toString(16).toUpperCase().match(/.{1,4}/g).join(":");

        if (subnet.contains(resultIPv6))
            return resultIPv6;

        return null;
    }
}

module.exports = {
    UtilHelper
}