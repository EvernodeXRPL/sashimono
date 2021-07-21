/**
    Entry point for Sashi-cli
**/
#include "pchheader.hpp"
#include "cli-manager.hpp"

#define PARSE_ERROR                                                                             \
    {                                                                                           \
        std::cerr << "Arguments mismatch.\n";                                                   \
        std::cerr << "Usage:\n";                                                                \
        std::cerr << "sashi status\n";                                                         \
        std::cerr << "sashi json <json message>\n";                                            \
        std::cerr << "Example: sashi json '{\"container_name\":\"<container name>\", ...}'\n"; \
        return -1;                                                                              \
    }

/**
 * Performs any cleanup on graceful application termination.
 */
void deinit()
{
    cli::deinit();
}

void sig_exit_handler(int signum)
{
    std::cout << "Interrupt signal (" << signum << ") received.\n";
    deinit();
    std::cout << "Sashi CLI exited due to signal.\n";
    exit(signum);
}

void segfault_handler(int signum)
{
    std::cout << boost::stacktrace::stacktrace() << std::endl;
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
            std::cerr << "std error: " << ex.what() << std::endl;
        }
        catch (...)
        {
            std::cerr << "std error: Terminated due to unknown exception\n";
        }
    }
    else
    {
        std::cerr << "std error: Terminated due to unknown reason\n";
    }

    std::cerr << boost::stacktrace::stacktrace() << std::endl;

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

    if (argc > 1)
    {
        // Take the realpath;
        std::array<char, PATH_MAX> buffer;
        ::realpath(argv[0], buffer.data());
        buffer[PATH_MAX] = '\0';
        cli::exec_dir = dirname(buffer.data());

        const std::string command = argv[1];

        if (command == "status")
        {
            std::string socket_path;
            if (cli::get_socket_path(socket_path) == -1)
                return -1;

            std::cout << socket_path << std::endl;
            return 0;
        }
        else if (command == "json" && argc == 3)
        {
            std::string output;
            if (cli::init() == -1 || cli::write_to_socket(argv[2]) == -1 || cli::read_from_socket(output) == -1)
            {
                cli::deinit();
                return -1;
            }

            std::cout << output << std::endl;
            cli::deinit();
            return 0;
        }
    }

    PARSE_ERROR
}