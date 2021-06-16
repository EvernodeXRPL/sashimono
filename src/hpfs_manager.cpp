#include "hpfs_manager.hpp"
#include "util/util.hpp"
#include "conf.hpp"

namespace hpfs
{
    constexpr ino_t ROOT_INO = 1;
    constexpr uint16_t HPFS_PROCESS_INIT_TIMEOUT = 2000;
    constexpr uint16_t HPFS_INIT_CHECK_INTERVAL = 20;

    /**
     * Starts the hpfs process for the instance.
     * @param fs_dir File system directory
     * @param mount_dir Mount directory.
     * @param log_level Log level for the hpfs.
     * @param merge Whether changes are needed to be merged.
     * @return -1 on error, pid of the spawned hpfs process if success.
     */
    int start_hpfs_process(std::string_view fs_dir, std::string_view mount_dir, std::string_view log_level, const bool merge)
    {
        const pid_t pid = fork();
        if (pid > 0)
        {
            // Sashimono process.

            LOG_DEBUG << "Starting hpfs process at " << mount_dir << ".";

            // Wait until hpfs is initialized properly.
            const uint16_t max_retries = HPFS_PROCESS_INIT_TIMEOUT / HPFS_INIT_CHECK_INTERVAL;
            bool hpfs_initialized = false;
            uint16_t retry_count = 0;
            do
            {
                util::sleep(HPFS_INIT_CHECK_INTERVAL);

                // Check if hpfs process is still running.
                // Sending signal 0 to test whether process exist.
                if (util::kill_process(pid, false, 0) == -1)
                {
                    LOG_ERROR << "hpfs process " << pid << " has stopped.";
                    break;
                }

                // We check for the specific inode no. of the mounted root dir. That means hpfs FUSE interface is up.
                struct stat st;
                if (stat(mount_dir.data(), &st) == -1)
                {
                    LOG_ERROR << errno << ": Error in checking hpfs status at mount " << mount_dir << ".";
                    break;
                }

                hpfs_initialized = (st.st_ino == ROOT_INO);
                // Keep retrying until root inode no. matches or timeout occurs.

            } while (!hpfs_initialized && ++retry_count <= max_retries);

            // Kill the process if hpfs couldn't be initialized properly.
            if (!hpfs_initialized)
            {
                LOG_ERROR << "Couldn't initialize hpfs process at mount " << mount_dir << ".";
                util::kill_process(pid, true);
                return -1;
            }

            LOG_DEBUG << "hpfs process started. pid:" << pid;
        }
        else if (pid == 0)
        {
            // hpfs process.
            util::fork_detach();

            std::string trace_arg = "trace=";
            trace_arg.append(log_level);

            // Fill process args.
            char *execv_args[] = {
                conf::ctx.hpfs_exe_path.data(),
                (char *)"fs",
                (char *)fs_dir.data(),
                (char *)mount_dir.data(),
                (char *)(merge ? "merge=true" : "merge=false"),
                (char *)trace_arg.data(),
                NULL};

            const int ret = execv(execv_args[0], execv_args);
            std::cerr << errno << ": hpfs process execv failed at mount " << mount_dir << ".\n";
            exit(1);
        }
        else
        {
            LOG_ERROR << errno << ": fork() failed when starting hpfs process at mount " << mount_dir << ".";
            return -1;
        }

        return pid;
    }

    /**
     * Creates hpfs processes for the instance.
     * @param contract_dir Contract directory.
     * @param log_level Log level for hpfs.
     * @param is_full_history Whether hpfs instances are for full history node.
     * @param pids pids of the hpfs instances.
     * @return -1 on error and 0 on success and pids will be populated.
     * 
    */
    int start_fs_processes(std::string_view contract_dir, std::string_view log_level, const bool is_full_history, hpfs_pids &pids)
    {
        const std::string contract_fs_path = conf::cfg.hp.instance_folder + "/" + (const char *)contract_dir.data() + "/contract_fs";
        const std::string ledger_fs_path = conf::cfg.hp.instance_folder + "/" + (const char *)contract_dir.data() + "/ledger_fs";

        int contract_fs_pid = start_hpfs_process(contract_fs_path, contract_fs_path + "/mnt", log_level, !is_full_history);
        int ledger_fs_pid = start_hpfs_process(ledger_fs_path, ledger_fs_path + "/mnt", log_level, true);

        if (contract_fs_pid == -1 || ledger_fs_pid == -1)
        {
            LOG_ERROR << errno << " : Error occured while starting contract fs processes - " << contract_dir;
            if (contract_fs_pid > 0)
                util::kill_process(contract_fs_pid, true);
            if (ledger_fs_pid > 0)
                util::kill_process(ledger_fs_pid, true);
            return -1;
        }

        pids = {contract_fs_pid, ledger_fs_pid};
        return 0;
    }

    /**
     * Stop given hpfs processes.
     * @param pids pids of the hpfs instances to be stopped.
     * @return -1 on error and 0 on success.
    */
    int stop_fs_processes(const hpfs_pids &pids)
    {
        if ((pids.contract > 0 && util::kill_process(pids.contract, true) == -1) || (pids.ledger > 0 && util::kill_process(pids.ledger, true) == -1))    
            return -1;

        return 0;
    }

} // namespace hp
