#include "hpfs_manager.hpp"
#include "util/util.hpp"
#include "conf.hpp"

namespace hpfs
{
    constexpr ino_t ROOT_INO = 1;
    constexpr uint16_t HPFS_PROCESS_INIT_TIMEOUT = 2000;
    constexpr uint16_t HPFS_INIT_CHECK_INTERVAL = 20;

    constexpr const char *KILL_HPFS = "sudo -H -u %s kill -9 $(pidof hpfs)";

    /**
     * Stop the hpfs process of the instance.
     * @param mount_dir Mount directory.
     */
    int stop_hpfs_process(std::string_view mount_dir)
    {
        // Umount the mount directory forcefully, need to be tested with MNT_DETACH flag.
        return umount2(mount_dir.data(), MNT_FORCE);
    }

    /**
     * Starts the hpfs process for the instance.
     * @param username Username of the instance user.
     * @param fs_dir File system directory
     * @param mount_dir Mount directory.
     * @param log_level Log level for the hpfs.
     * @param merge Whether changes are needed to be merged.
     * @return -1 on error, pid of the spawned hpfs process if success.
     */
    int start_hpfs_process(std::string_view username, std::string_view fs_dir, std::string_view mount_dir, std::string_view log_level, const bool merge)
    {
        util::user_info user;
        if (util::get_system_user_info(username, user) == -1)
            return -1;

        const pid_t pid = fork();
        // if (pid > 0)
        // {
        //     // Sashimono process.

        //     LOG_DEBUG << "Starting hpfs process at " << mount_dir << ".";

        //     // Wait until hpfs is initialized properly.
        //     const uint16_t max_retries = HPFS_PROCESS_INIT_TIMEOUT / HPFS_INIT_CHECK_INTERVAL;
        //     bool hpfs_initialized = false;
        //     uint16_t retry_count = 0;
        //     do
        //     {
        //         util::sleep(HPFS_INIT_CHECK_INTERVAL);

        //         // Check if hpfs process is still running.
        //         // Sending signal 0 to test whether process exist.
        //         if (util::kill_process(pid, false, 0) == -1)
        //         {
        //             LOG_ERROR << "hpfs process " << pid << " has stopped.";
        //             break;
        //         }

        //         // We check for the specific inode no. of the mounted root dir. That means hpfs FUSE interface is up.
        //         struct stat st;
        //         if (stat(mount_dir.data(), &st) == -1)
        //         {
        //             LOG_ERROR << errno << ": Error in checking hpfs status at mount " << mount_dir << ".";
        //             break;
        //         }

        //         hpfs_initialized = (st.st_ino == ROOT_INO);
        //         // Keep retrying until root inode no. matches or timeout occurs.

        //     } while (!hpfs_initialized && ++retry_count <= max_retries);

        //     // Kill the process if hpfs couldn't be initialized properly.
        //     if (!hpfs_initialized)
        //     {
        //         LOG_ERROR << "Couldn't initialize hpfs process at mount " << mount_dir << ".";
        //         util::kill_process(pid, true);
        //         return -1;
        //     }

        //     LOG_DEBUG << "hpfs process started. pid:" << pid;
        // }
        // else
        if (pid == 0)
        {
            // hpfs process.
            util::fork_detach();

            // Detach hpfs terminal outputs from the sagent terminal, These will be printed in the trace log of particular hpfs mount.
            int fd = open("/dev/null", O_WRONLY);
            dup2(fd, STDOUT_FILENO);
            dup2(fd, STDERR_FILENO);
            close(fd);

            std::string trace_arg = "trace=";
            trace_arg.append(log_level);
            char *execv_args[] = {
                conf::ctx.hpfs_exe_path.data(),
                (char *)"fs",
                (char *)fs_dir.data(),
                (char *)mount_dir.data(),
                (char *)(merge ? "merge=true" : "merge=false"),
                (char *)trace_arg.data(),
                NULL};

            setgid(user.group_id);
            setuid(user.user_id);
            const int ret = execv(execv_args[0], execv_args);
            std::cerr << errno << ": hpfs process start failed at mount " << mount_dir << ".\n";
            exit(1);
        }
        // else
        // {
        //     LOG_ERROR << errno << ": fork() failed when starting hpfs process at mount " << mount_dir << ".";
        //     return -1;
        // }

        return pid;
    }

    /**
     * Creates hpfs processes for the instance.
     * @param username Username of the instance user.
     * @param contract_dir Contract directory.
     * @param log_level Log level for hpfs.
     * @param is_full_history Whether hpfs instances are for full history node.
     * @return -1 on error and 0 on success.
     * 
    */
    int start_fs_processes(std::string_view username, const std::string &contract_dir, std::string_view log_level, const bool is_full_history)
    {
        std::string fs_path = contract_dir + "/contract_fs";
        std::string mnt_path = fs_path + "/mnt";
        if (start_hpfs_process(username, fs_path, mnt_path, log_level, !is_full_history) <= 0)
        {
            LOG_ERROR << errno << " : Error occured while starting contract_fs processes - " << contract_dir;
            return -1;
        }

        fs_path = contract_dir + "/ledger_fs";
        mnt_path = fs_path + "/mnt";
        if (start_hpfs_process(username, fs_path, mnt_path + "/mnt", log_level, true) <= 0)
        {
            LOG_ERROR << errno << " : Error occured while starting ledger_fs processes - " << contract_dir;
            return -1;
        }

        return 0;
    }

    /**
     * Stop hpfs processes of the instance.
     * @param username Username of the instance user.
     * @param contract_dir Contract directory.
     * @return -1 on error and 0 on success and pids will be populated.
     * 
    */
    int stop_fs_processes(std::string_view username, const std::string &contract_dir)
    {
        std::string mnt_path = contract_dir + "/contract_fs/mnt";
        if (stop_hpfs_process(mnt_path) == -1)
        {
            LOG_ERROR << errno << " : Error occured while umounting contract_fs - " << contract_dir;
            return -1;
        }

        mnt_path = contract_dir + "/ledger_fs/mnt";
        if (stop_hpfs_process(mnt_path) == -1)
        {
            LOG_ERROR << errno << " : Error occured while umounting ledger_fs - " << contract_dir;
            return -1;
        }

        const int len = 34 + username.length();
        char command[len];
        sprintf(command, KILL_HPFS, username.data());
        if (system(command) != 0)
        {
            LOG_ERROR << "Error when killing hpfs processes. username: " << username;
            return -1;
        }

        return 0;
    }

} // namespace hp
