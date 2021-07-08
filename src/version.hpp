#ifndef _SA_VERSION_
#define _SA_VERSION_

#include "pchheader.hpp"

namespace version
{
    // Sashimono agent version. Written to new configs.
    constexpr const char *AGENT_VERSION = "1.0.0";

    // Minimum compatible config version (this will be used to validate configs).
    constexpr const char *MIN_CONFIG_VERSION = "1.0.0";

    int version_compare(const std::string &x, const std::string &y);
}

#endif