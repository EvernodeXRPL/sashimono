#ifndef _SA_HPFS_MANAGER_
#define _SA_HPFS_MANAGER_

#include "pchheader.hpp"

namespace hpfs
{
    int start_hpfs_process(std::string_view username, std::string_view fs_dir, std::string_view mount_dir, std::string_view log_level, const bool merge);
    int stop_hpfs_process(std::string_view mount_dir);
    int start_fs_processes(std::string_view username, const std::string &contract_dir, std::string_view log_level, const bool is_full_history);
    int stop_fs_processes(std::string_view username, const std::string &contract_dir);
} // namespace hpfs
#endif