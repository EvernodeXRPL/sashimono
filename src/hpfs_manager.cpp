#include "hpfs_manager.hpp"
#include "util/util.hpp"
#include "conf.hpp"

namespace hpfs
{
    /**
     * Start hpfs systemd services of the instance.
     * @param username Username of the instance user.
     * @return -1 on error and 0 on success.
     * 
    */
    int start_hpfs_systemd(const std::string &username)
    {
        const std::string contract_fs_start = "sudo -u " + username + " XDG_RUNTIME_DIR=/run/user/$(id -u " + username + ") systemctl --user start contract_fs";
        const std::string contract_fs_enable = "sudo -u " + username + " XDG_RUNTIME_DIR=/run/user/$(id -u " + username + ") systemctl --user enable contract_fs";
        const std::string ledger_fs_start = "sudo -u " + username + " XDG_RUNTIME_DIR=/run/user/$(id -u " + username + ") systemctl --user start ledger_fs";
        const std::string ledger_fs_enable = "sudo -u " + username + " XDG_RUNTIME_DIR=/run/user/$(id -u " + username + ") systemctl --user enable ledger_fs";

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
        const std::string contract_fs_stop = "sudo -u " + username + " XDG_RUNTIME_DIR=/run/user/$(id -u " + username + ") systemctl --user stop contract_fs";
        const std::string contract_fs_disable = "sudo -u " + username + " XDG_RUNTIME_DIR=/run/user/$(id -u " + username + ") systemctl --user disable contract_fs";
        const std::string ledger_fs_stop = "sudo -u " + username + " XDG_RUNTIME_DIR=/run/user/$(id -u " + username + ") systemctl --user stop ledger_fs";
        const std::string ledger_fs_disable = "sudo -u " + username + " XDG_RUNTIME_DIR=/run/user/$(id -u " + username + ") systemctl --user disable ledger_fs";

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
