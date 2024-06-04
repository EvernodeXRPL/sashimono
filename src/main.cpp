/**
    Entry point for Sashimono
**/
#include "pchheader.hpp"
#include "conf.hpp"
#include "sqlite.hpp"
#include "salog.hpp"
#include "comm/comm_handler.hpp"
#include "hp_manager.hpp"
#include "crypto.hpp"
#include "hp_manager.hpp"
#include "version.hpp"
#include "util/util.hpp"
#include "killswitch/killswitch.h"

#define PARSE_ERROR                                                                                                                        \
    {                                                                                                                                      \
        std::cerr << "Arguments mismatch.\n";                                                                                              \
        std::cerr << "Usage:\n";                                                                                                           \
        std::cerr << "sagent version\n";                                                                                                   \
        std::cerr << "sagent new [data_dir] [host_addr] [registry_addr] [inst_count] [cpu_us] [ram_kbytes] [swap_kbytes] [disk_kbytes]\n"; \
        std::cerr << "sagent run [data_dir]\n";                                                                                            \
        std::cerr << "sagent upgrade [data_dir]\n";                                                                                        \
        std::cerr << "sagent reconfig [data_dir] [inst_count] [cpu_us] [ram_kbytes] [swap_kbytes] [disk_kbytes]\n";                        \
        std::cerr << "Example: sagent run /etc/sashimono\n";                                                                               \
        return -1;                                                                                                                         \
    }

/**
 * Parses CLI args and extracts sashimono agent command and parameters given.
 * @param argc Argument count.
 * @param argv Arguments.
 * @returns 0 on success, -1 on error.
 */
int parse_cmd(int argc, char **argv)
{
    if (argc > 1)
    {
        conf::ctx.command = argv[1];

        if ((conf::ctx.command == "new" && argc >= 2 && argc <= 12) ||
            (conf::ctx.command == "run" && argc >= 2 && argc <= 3) ||
            (conf::ctx.command == "upgrade" && argc >= 2 && argc <= 3) ||
            (conf::ctx.command == "version" && argc == 2) ||
            (conf::ctx.command == "reconfig" && argc >= 2 && argc <= 8))
            return 0;
    }

    // If all extractions fail display help message and return -1.
    PARSE_ERROR
}

/**
 * Performs any cleanup on graceful application termination.
 */
void deinit()
{
    comm::deinit();
    hp::deinit();
}

void sig_exit_handler(int signum)
{
    LOG_WARNING << "Interrupt signal (" << signum << ") received.";
    deinit();
    LOG_WARNING << "sagent exited due to signal.";
    exit(signum);
}

void segfault_handler(int signum)
{
    LOG_ERROR << boost::stacktrace::stacktrace();
    exit(SIGABRT);
}

/**
 * Global exception handler for std exceptions.
 */
void std_terminate() noexcept
{
    const std::exception_ptr exptr = std::current_exception();
    if (exptr != 0)
    {
        try
        {
            std::rethrow_exception(exptr);
        }
        catch (std::exception &ex)
        {
            LOG_ERROR << "std error: " << ex.what();
        }
        catch (...)
        {
            LOG_ERROR << "std error: Terminated due to unknown exception";
        }
    }
    else
    {
        LOG_ERROR << "std error: Terminated due to unknown reason";
    }

    LOG_ERROR << boost::stacktrace::stacktrace();

    exit(1);
}

int main(int argc, char **argv)
{
    // Register exception and segfault handlers.
    std::set_terminate(&std_terminate);
    signal(SIGSEGV, &segfault_handler);
    signal(SIGABRT, &segfault_handler);

    // Disable SIGPIPE to avoid crashing on broken pipe IO.
    {
        sigset_t mask;
        sigemptyset(&mask);
        sigaddset(&mask, SIGPIPE);
        pthread_sigmask(SIG_BLOCK, &mask, NULL);
    }

    // Extract the CLI args
    // This call will populate conf::ctx
    if (parse_cmd(argc, argv) != 0)
        return 1;

    if (conf::ctx.command == "version")
    {
        std::cout << version::AGENT_VERSION << "\n";
    }
    if (conf::ctx.command == "new")
    {
        conf::set_dir_paths(argv[0], (argc >= 3) ? argv[2] : "");

        // This will create a new config.
        const std::string host_addr = (argc >= 4) ? argv[3] : "";
        uint16_t init_peer_port = 0, init_user_port = 0, init_gp_tcp_port = 0, init_gp_udp_port = 0, docker_registry_port = 0;
        size_t inst_count = 0, cpu_us = 0, ram_kbytes = 0, swap_kbytes = 0, disk_kbytes = 0;

        if (((argc >= 5) && util::stoul(argv[4], init_peer_port) != 0) ||
            ((argc >= 6) && util::stoul(argv[5], init_user_port) != 0) ||
            ((argc >= 7) && util::stoul(argv[6], init_gp_tcp_port) != 0) ||
            ((argc >= 8) && util::stoul(argv[7], init_gp_udp_port) != 0) ||
            ((argc >= 9) && util::stoul(argv[8], docker_registry_port) != 0) ||
            ((argc >= 10) && (util::stoull(argv[9], inst_count) != 0 || inst_count == 0)) ||
            ((argc >= 11) && (util::stoull(argv[10], cpu_us) != 0 || cpu_us == 0)) ||
            ((argc >= 12) && (util::stoull(argv[11], ram_kbytes) != 0 || ram_kbytes == 0)) ||
            ((argc >= 13) && (util::stoull(argv[12], swap_kbytes) != 0 || swap_kbytes == 0)) ||
            ((argc >= 14) && (util::stoull(argv[13], disk_kbytes) != 0 || disk_kbytes == 0)) ||
            conf::create(host_addr, init_peer_port, init_user_port, init_gp_tcp_port, init_gp_udp_port, docker_registry_port, inst_count, cpu_us, ram_kbytes, swap_kbytes, disk_kbytes) != 0)
        {
            std::cerr << "Invalid Sashimono Agent config creation args.\n";
            std::cerr << docker_registry_port << ", " << inst_count << ", " << cpu_us << ", " << ram_kbytes << ", "
                      << swap_kbytes << ", " << disk_kbytes << "\n";
            return 1;
        }
    }
    else if (conf::ctx.command == "run")
    {
        conf::set_dir_paths(argv[0], (argc == 3) ? argv[2] : "");

        if (kill_switch(util::get_epoch_milliseconds()))
        {
            std::cerr << "Sashimono Agent usage limit failure.\n";
            return 1;
        }

        if (conf::init() != 0)
            return 1;

        salog::init();

        if (crypto::init() == -1)
            return 1;

        LOG_INFO << "Sashimono agent (version " << version::AGENT_VERSION << ") --- patch applied ---";
        LOG_INFO << "Log level: " << conf::cfg.log.log_level;
        LOG_INFO << "Data dir: " << conf::ctx.data_dir;

        if (comm::init() == -1 || hp::init() == -1)
        {
            deinit();
            return 1;
        }

        // After initializing primary subsystems, register the exit handler.
        signal(SIGINT, &sig_exit_handler);
        signal(SIGTERM, &sig_exit_handler);

        // Waiting for the websocket sessions.
        comm::wait();

        deinit();

        LOG_INFO << "sashimono agent exited normally.";
    }
    else if (conf::ctx.command == "upgrade")
    {
        conf::set_dir_paths(argv[0], (argc == 3) ? argv[2] : "");

        if (conf::init() != 0)
            return 1;

        salog::init();

        // Do a simple version change in the config.
        conf::cfg.version = version::AGENT_VERSION;

        if (conf::cfg.docker.registry_port == 0)
            conf::cfg.docker.registry_port = 4444;

        if (conf::write_config(conf::cfg) != 0)
            return -1;
    }
    else if (conf::ctx.command == "reconfig")
    {
        conf::set_dir_paths(argv[0], (argc >= 3) ? argv[2] : "");

        size_t inst_count = 0, cpu_us = 0, ram_kbytes = 0, swap_kbytes = 0, disk_kbytes = 0;

        if (((argc >= 4) && (util::stoull(argv[3], inst_count) != 0)) ||
            ((argc >= 5) && (util::stoull(argv[4], cpu_us) != 0)) ||
            ((argc >= 6) && (util::stoull(argv[5], ram_kbytes) != 0)) ||
            ((argc >= 7) && (util::stoull(argv[6], swap_kbytes) != 0)) ||
            ((argc >= 8) && (util::stoull(argv[7], disk_kbytes) != 0)))
        {
            std::cerr << "Invalid Sashimono Agent config update args.\n";
            std::cerr << inst_count << ", " << cpu_us << ", " << ram_kbytes << ", "
                      << swap_kbytes << ", " << disk_kbytes << "\n";
            return 1;
        }

        if (conf::init() != 0)
            return 1;

        // Return if not changed.
        if ((inst_count == 0 || conf::cfg.system.max_instance_count == inst_count) &&
            (cpu_us == 0 || conf::cfg.system.max_cpu_us == cpu_us) &&
            (ram_kbytes == 0 || conf::cfg.system.max_mem_kbytes == ram_kbytes) &&
            (swap_kbytes == 0 || conf::cfg.system.max_swap_kbytes == swap_kbytes) &&
            (disk_kbytes == 0 || conf::cfg.system.max_storage_kbytes == disk_kbytes))
            return 0;

        salog::init();

        if (hp::init() == -1)
            return 1;

        std::vector<hp::instance_info> instances;
        hp::get_instance_list(instances);
        hp::deinit();

        // If there are active instances, do not allow reducing the resources per instance. Otherwise we allow adjusting resources.
        if (inst_count != 0 && instances.size() > inst_count)
        {
            std::cerr << "There are " << instances.size() << " active instances, So max instance count cannot be less than that.\n";
            return 1;
        }
        else if (instances.size() > 0)
        {
            size_t new_count = inst_count != 0 ? inst_count : conf::cfg.system.max_instance_count;
            size_t new_cpu = cpu_us != 0 ? cpu_us : conf::cfg.system.max_cpu_us;
            size_t new_ram = ram_kbytes != 0 ? ram_kbytes : conf::cfg.system.max_mem_kbytes;
            size_t new_swap = swap_kbytes != 0 ? swap_kbytes : conf::cfg.system.max_swap_kbytes;
            size_t new_disk = disk_kbytes != 0 ? disk_kbytes : conf::cfg.system.max_storage_kbytes;

            if (new_cpu / new_count < conf::cfg.system.max_cpu_us / conf::cfg.system.max_instance_count)
            {
                std::cerr << "CPU per instance should be greater than " << conf::cfg.system.max_cpu_us / conf::cfg.system.max_instance_count << " Micro Sec.\n";
                return 1;
            }
            else if (new_ram / new_count < conf::cfg.system.max_mem_kbytes / conf::cfg.system.max_instance_count)
            {
                std::cerr << "RAM per instance should be greater than " << conf::cfg.system.max_mem_kbytes / conf::cfg.system.max_instance_count << " KB.\n";
                return 1;
            }
            else if (new_swap / new_count < conf::cfg.system.max_swap_kbytes / conf::cfg.system.max_instance_count)
            {
                std::cerr << "Swap per instance should be greater than " << conf::cfg.system.max_swap_kbytes / conf::cfg.system.max_instance_count << " KB.\n";
                return 1;
            }
            else if (new_disk / new_count < conf::cfg.system.max_storage_kbytes / conf::cfg.system.max_instance_count)
            {
                std::cerr << "Storage per instance should be greater than " << conf::cfg.system.max_storage_kbytes / conf::cfg.system.max_instance_count << " KB.\n";
                return 1;
            }
        }

        if (inst_count > 0)
            conf::cfg.system.max_instance_count = inst_count;

        if (cpu_us > 0)
            conf::cfg.system.max_cpu_us = cpu_us;

        if (ram_kbytes > 0)
            conf::cfg.system.max_mem_kbytes = ram_kbytes;

        if (swap_kbytes > 0)
            conf::cfg.system.max_swap_kbytes = swap_kbytes;

        if (disk_kbytes > 0)
            conf::cfg.system.max_storage_kbytes = disk_kbytes;

        if (conf::write_config(conf::cfg) != 0)
            return -1;
    }

    return 0;
}