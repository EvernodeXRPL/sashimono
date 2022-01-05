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

        if ((conf::ctx.command == "new" && argc >= 2 && argc <= 10) ||
            (conf::ctx.command == "run" && argc >= 2 && argc <= 3) ||
            (conf::ctx.command == "version" && argc == 2))
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
        size_t inst_count = 0, cpu_us = 0, ram_kbytes = 0, swap_kbytes = 0, disk_kbytes = 0;

        if (((argc >= 5) && (util::stoull(argv[4], inst_count) != 0 || inst_count == 0)) ||
            ((argc >= 6) && (util::stoull(argv[5], cpu_us) != 0 || cpu_us == 0)) ||
            ((argc >= 7) && (util::stoull(argv[6], ram_kbytes) != 0 || ram_kbytes == 0)) ||
            ((argc >= 8) && (util::stoull(argv[7], swap_kbytes) != 0 || swap_kbytes == 0)) ||
            ((argc >= 9) && (util::stoull(argv[8], disk_kbytes) != 0 || disk_kbytes == 0)) ||
            conf::create(host_addr, "", inst_count, cpu_us, ram_kbytes, swap_kbytes, disk_kbytes) != 0)
        {
            std::cerr << "Invalid Sashimono Agent config creation args.\n";
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

        salog::init(); // Initialize logger for SA.

        if (crypto::init() == -1)
            return 1;

        LOG_INFO << "Sashimono agent (version " << version::AGENT_VERSION << ")";
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

    return 0;
}