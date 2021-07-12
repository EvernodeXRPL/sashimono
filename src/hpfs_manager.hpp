#ifndef _SA_HPFS_MANAGER_
#define _SA_HPFS_MANAGER_

#include "pchheader.hpp"

namespace hpfs
{
    int register_hpfs_systemd(std::string_view username, const std::string &contract_dir, std::string_view log_level, const bool is_full_history);
    int start_hpfs_systemd(const std::string &username);
    int stop_hpfs_systemd(const std::string &username);
} // namespace hpfs
#endif