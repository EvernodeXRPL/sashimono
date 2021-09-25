/**
    Entry point for Sashi-cli
**/
#include "pchheader.hpp"
#include "cli-manager.hpp"

const char *BASIC_MSG = "{\"type\":\"%s\",\"container_name\":\"%s\"}";

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

int write_msg(std::string_view exec_dir, std::string_view json_message)
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

int write_basic_msg(std::string_view exec_dir, std::string_view type, std::string_view container_name)
{
    std::string msg;
    msg.resize(512);
    sprintf(msg.data(), BASIC_MSG, type.data(), container_name.data());
    return write_msg(exec_dir, msg);
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
    CLI::App *version = app.add_subcommand("version", "Displays Sashimono CLI version.");
    CLI::App *status = app.add_subcommand("status", "Check socket accessibility.");
    CLI::App *list = app.add_subcommand("list", "List all instances.");
    CLI::App *json = app.add_subcommand("json", "JSON payload. Example: sashi json -m '{\"type\":\"<instruction_type>\", ...}'");
    CLI::App *start = app.add_subcommand("start", "Starts an instance.");
    CLI::App *stop = app.add_subcommand("stop", "Stops an instance.");
    CLI::App *destroy = app.add_subcommand("destroy", "Destroys an instance.");

    // Initialize options.
    std::string json_message;
    json->add_option("-m,--message", json_message, "JSON message");

    std::string container_name;
    start->add_option("-n,--name", container_name, "Instance name");
    stop->add_option("-n,--name", container_name, "Instance name");
    destroy->add_option("-n,--name", container_name, "Instance name");

    CLI11_PARSE(app, argc, argv);

    // Take the realpath of sash exec path.
    std::array<char, PATH_MAX> buffer;
    ::realpath(argv[0], buffer.data());
    buffer[PATH_MAX] = '\0';
    const std::string exec_dir = dirname(buffer.data());

    // Verifying subcommands.
    if (version->parsed())
    {
        std::cout << "Sashimono CLI version 1.0.0" << std::endl;
        return 0;
    }
    else if (status->parsed())
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
        return write_msg(exec_dir, json_message);
    }
    else if (start->parsed() && !container_name.empty())
    {
        return write_basic_msg(exec_dir, "start", container_name);
    }
    else if (stop->parsed() && !container_name.empty())
    {
        return write_basic_msg(exec_dir, "stop", container_name);
    }
    else if (destroy->parsed() && !container_name.empty())
    {
        return write_basic_msg(exec_dir, "destroy", container_name);
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