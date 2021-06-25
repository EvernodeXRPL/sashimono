#ifndef _SA_CRYPTO_
#define _SA_CRYPTO_

#include "pchheader.hpp"

/**
 * Offers convenience functions for cryptographic operations wrapping libsodium.
 * These functions are used for config and user/peer message authentication.
 */
namespace crypto
{

    // Prefix byte to append to ed25519 keys.
    static unsigned char KEYPFX_ed25519 = 0xED;

    int init();

    void random_bytes(std::string &result, const size_t len);

    void generate_signing_keys(std::string &pubkey, std::string &seckey);

    const std::string generate_uuid();

    const bool verify_uuid(const std::string &uuid);
}
#endif