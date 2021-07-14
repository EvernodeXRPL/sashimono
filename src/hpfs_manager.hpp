#ifndef _SA_HPFS_MANAGER_
#define _SA_HPFS_MANAGER_

#include "pchheader.hpp"

namespace hpfs
{
    int start_hpfs_systemd(const std::string &username);
    int stop_hpfs_systemd(const std::string &username);
    int update_service_conf(const std::string &username, const std::string &log_level, const bool is_full_history);
} // namespace hpfs
#endif