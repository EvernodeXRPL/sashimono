#ifndef _SA_HPFS_MANAGER_
#define _SA_HPFS_MANAGER_

#include "pchheader.hpp"

namespace hpfs
{
    struct hpfs_pids
    {
        pid_t contract = 0;
        pid_t ledger = 0;
    };

    int start_hpfs_process(std::string_view fs_dir, std::string_view mount_dir, std::string_view log_level, const bool merge = true);
    int start_fs_processes(std::string_view contract_dir, std::string_view log_level, const bool is_full_history, hpfs_pids &pids);
    int stop_fs_processes(const hpfs_pids &pids);
} // namespace hpfs
#endif