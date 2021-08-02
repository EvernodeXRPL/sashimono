/**
    Entry point for Sashi-cli
**/
#include "pchheader.hpp"
#include "cli-manager.hpp"

/**
 * Performs any cleanup on graceful application termination.
 */
void deinit()
{
    cli::deinit();
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

/**
 * Parses CLI args and extracts sashimono agent command and parameters given using CLI11 library.
 * @param argc Argument count.
 * @param argv Arguments.
 * @returns 0 on success, -1 on error.
 */
int parse_cmd(int argc, char **argv)
{
    // Initialize CLI.
    CLI::App app("Sashimono CLI");
    app.set_help_all_flag("--help-all", "Expand all help");

    // Initialize subcommands.
    CLI::App *status = app.add_subcommand("status", "Check socket accessibility.");
    CLI::App *list = app.add_subcommand("list", "List all instances.");
    CLI::App *json = app.add_subcommand("json", "JSON payload. Example: sashi json -m '{\"type\":\"<instruction_type>\", ...}'");

    // Initialize options.
    std::string json_message;
    json->add_option("-m,--message", json_message, "JSON message");

    CLI11_PARSE(app, argc, argv);

    // Take the realpath of sash exec path.
    std::array<char, PATH_MAX> buffer;
    ::realpath(argv[0], buffer.data());
    buffer[PATH_MAX] = '\0';
    const std::string exec_dir = dirname(buffer.data());

    // Verifying subcommands.
    if (status->parsed())
    {
        if (cli::init(exec_dir) == -1)
            return -1;

        std::cout << cli::ctx.socket_path << std::endl;
        cli::deinit();
        return 0;
    }
    else if (list->parsed())
    {
        if (cli::init(exec_dir) == -1)
            return -1;
        if (cli::list() == -1)
        {
            std::cerr << "Failed to list instances." << std::endl;
            cli::deinit();
            return -1;
        }
        cli::deinit();
        return 0;
    }
    else if (json->parsed() && !json_message.empty())
    {
        std::string output;
        if (cli::init(exec_dir) == -1 || cli::write_to_socket(json_message) == -1 || cli::read_from_socket(output) == -1)
        {
            cli::deinit();
            return -1;
        }

        std::cout << output << std::endl;
        cli::deinit();
        return 0;
    }

    std::cout << app.help();
    return -1;
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
        // sigprocmask is used instead of pthread_sigmask since this is single threaded.
        sigprocmask(SIG_BLOCK, &mask, NULL);
    }

    return parse_cmd(argc, argv);
}