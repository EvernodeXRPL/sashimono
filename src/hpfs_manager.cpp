#include "hpfs_manager.hpp"
#include "util/util.hpp"
#include "conf.hpp"

namespace hpfs
{
    /**
     * Creates hpfs systemd services for the instance.
     * @param username Username of the instance user.
     * @param contract_dir Contract directory.
     * @param log_level Log level for hpfs.
     * @param is_full_history Whether hpfs instances are for full history node.
     * @return -1 on error and 0 on success.
     * 
    */
    int register_hpfs_systemd(std::string_view username, const std::string &contract_dir, std::string_view log_level, const bool is_full_history)
    {
        std::vector<std::string> output;
        const std::string contract_dir_absolute = util::realpath(contract_dir);
        const std::vector<std::string_view> input_params = {username, contract_dir_absolute, log_level, is_full_history ? "false" : "true"};

        return util::execute_bash_file(conf::ctx.hpfs_systemd_sh, output, input_params);
    }

    /**
     * Start hpfs systemd services of the instance.
     * @param username Username of the instance user.
     * @return -1 on error and 0 on success.
     * 
    */
    int start_hpfs_systemd(const std::string &username)
    {
        const std::string contract_fs_start = "sudo systemctl start " + username + "-contract_fs";
        const std::string contract_fs_enable = "sudo systemctl enable " + username + "-contract_fs";
        const std::string ledger_fs_start = "sudo systemctl start " + username + "-ledger_fs";
        const std::string ledger_fs_enable = "sudo systemctl enable " + username + "-ledger_fs";

        if (system(contract_fs_start.c_str()) == -1 ||
            system(ledger_fs_start.c_str()) == -1 ||
            system(contract_fs_enable.c_str()) == -1 ||
            system(ledger_fs_enable.c_str()) == -1)
        {
            LOG_ERROR << "Error stopping and disabling hpfs systemd services for user: " << username;
            return -1;
        }

        return 0;
    }

    /**
     * Stop hpfs systemd services of the instance.
     * @param username Username of the instance user.
     * @return -1 on error and 0 on success.
     * 
    */
    int stop_hpfs_systemd(const std::string &username)
    {
        const std::string contract_fs_stop = "sudo systemctl stop " + username + "-contract_fs";
        const std::string contract_fs_disable = "sudo systemctl disable " + username + "-contract_fs";
        const std::string ledger_fs_stop = "sudo systemctl stop " + username + "-ledger_fs";
        const std::string ledger_fs_disable = "sudo systemctl disable " + username + "-ledger_fs";

        if (system(contract_fs_stop.c_str()) == -1 ||
            system(ledger_fs_stop.c_str()) == -1 ||
            system(contract_fs_disable.c_str()) == -1 ||
            system(ledger_fs_disable.c_str()) == -1)
        {
            LOG_ERROR << "Error stopping and disabling hpfs systemd services for user: " << username;
            return -1;
        }

        return 0;
    }

} // namespace hp
