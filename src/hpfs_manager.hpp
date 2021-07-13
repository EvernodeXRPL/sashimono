#ifndef _SA_HPFS_MANAGER_
#define _SA_HPFS_MANAGER_

#include "pchheader.hpp"

namespace hpfs
{
    int start_hpfs_systemd(const std::string &username);
    int stop_hpfs_systemd(const std::string &username);
} // namespace hpfs
#endif