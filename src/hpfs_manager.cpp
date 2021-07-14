#include "hpfs_manager.hpp"
#include "util/util.hpp"
#include "conf.hpp"

namespace hpfs
{
    constexpr int FILE_PERMS = 0644;
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

    /**
     * Update service configuration file for the instance with hpfs related config values.
     * @param username Username of the instance user.
     * @param log_level Log level for hpfs.
     * @param is_full_history Flag to indicate if full history is enabled.
     * @return -1 on error and 0 on success.
    */
    int update_service_conf(const std::string &username, const std::string &log_level, const bool is_full_history)
    {
        const std::string path = "/home/" + username + "/.serviceconf";
        const int fd = open(path.c_str(), O_CREAT | O_RDWR, 0644);
        if (fd == -1)
        {
            std::cout << errno << ": Error opening service configuration file at " << path;
            return -1;
        }
        char buf[1024];
        const int res = read(fd, buf, sizeof(buf));
        if (res == -1)
        {
            std::cout << errno << ": Error reading service configuration file at " << path;
            close(fd);
            return -1;
        }
        buf[res] = '\0'; // EOF
        std::map<std::string, std::string> data;
        std::stringstream ss(buf);
        std::string line;
        while (getline(ss, line))
        {
            const size_t end = line.find("=");
            if (end != std::string::npos)
                data.insert(std::make_pair(line.substr(0, end), line.substr(end + 1, line.length() - end)));
        }
        data["HPFS_MERGE"] = is_full_history ? "false" : "true";
        data["HPFS_TRACE"] = log_level;

        std::string content;
        for (const auto &[key, value] : data)
            content += key + "=" + value + "\n";

        if (ftruncate(fd, 0) == -1 || pwrite(fd, content.c_str(), content.length(), 0) == -1)
        {
            std::cout << "Error writing to service configuration file at " << path;
            close(fd);
            return -1;
        }

        close(fd);
        return 0;
    }

} // namespace hp
