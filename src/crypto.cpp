#include "crypto.hpp"
#include "util/util.hpp"

namespace crypto
{

    /**
     * Initializes the crypto subsystem. Must be called once during application startup.
     * @return 0 for successful initialization. -1 for failure.
     */
    int init()
    {
        if (sodium_init() < 0)
        {
            std::cerr << "sodium_init failed.\n";
            return -1;
        }

        return 0;
    }

    /**
     * Generates a signing key pair using libsodium and assigns them to the provided strings.
     */
    void generate_signing_keys(std::string &pubkey, std::string &seckey)
    {
        // Generate key pair using libsodium default algorithm.
        // Currently using ed25519. So append prefix byte to represent that.

        pubkey.resize(crypto_sign_ed25519_PUBLICKEYBYTES + 1);
        pubkey[0] = crypto::KEYPFX_ed25519;

        seckey.resize(crypto_sign_ed25519_SECRETKEYBYTES + 1);
        seckey[0] = crypto::KEYPFX_ed25519;

        crypto_sign_ed25519_keypair(
            reinterpret_cast<unsigned char *>(pubkey.data() + 1),  // +1 to skip the prefix byte.
            reinterpret_cast<unsigned char *>(seckey.data() + 1)); // +1 to skip the prefix byte.
    }

    /**
     * Generate random bytes of specified length.
     */
    void random_bytes(std::string &result, const size_t len)
    {
        result.resize(len);
        randombytes_buf(result.data(), len);
    }

    const std::string generate_uuid()
    {
        std::string rand_bytes;
        random_bytes(rand_bytes, 16);

        // Set bits for UUID v4 variant 1.
        uint8_t *uuid = (uint8_t *)rand_bytes.data();
        uuid[6] = (uuid[8] & 0x0F) | 0x40;
        uuid[8] = (uuid[8] & 0xBF) | 0x80;

        const std::string hex = util::to_hex(rand_bytes);
        return hex.substr(0, 8) + "-" + hex.substr(8, 4) + "-" + hex.substr(12, 4) + "-" + hex.substr(16, 4) + "-" + hex.substr(20);
    }

    const bool verify_uuid(const std::string &uuid)
    {
        if (uuid.empty() || uuid.length() != 36)
            return false;

        const std::regex pattern("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-4[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$");
        return std::regex_match(uuid, pattern);        
    }
}