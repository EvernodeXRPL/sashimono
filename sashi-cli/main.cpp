/**
    Entry point for Sashi-cli
**/
#include "pchheader.hpp"
#include "cli-manager.hpp"
#include "version.hpp"

std::string exec_dir;

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

template <typename executor>
int execute_cli(executor const &func)
{
    if (cli::init(exec_dir) == -1)
        return -1;

    const int ret = func();
    cli::deinit();
    return ret;
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
    CLI::App *create = app.add_subcommand("create", "Creates an instance.");
    CLI::App *start = app.add_subcommand("start", "Starts an instance.");
    CLI::App *stop = app.add_subcommand("stop", "Stops an instance.");
    CLI::App *destroy = app.add_subcommand("destroy", "Destroys an instance.");
    CLI::App *attach = app.add_subcommand("attach", "Attachs to the bash of a instance.");

    // Initialize options.
    std::string json_message;
    json->add_option("-m,--message", json_message, "JSON message");

    std::string owner, contract_id, image;
    create->add_option("-o,--owner", owner, "Hex (ed-prefixed) public key of the instance owner");
    create->add_option("-c,--contract-id", contract_id, "Contract Id (GUID) of the instance");
    create->add_option("-i,--image", image, "Container image to use");

    std::string container_name;
    create->add_option("-n,--name", container_name, "Instance name");
    start->add_option("-n,--name", container_name, "Instance name");
    stop->add_option("-n,--name", container_name, "Instance name");
    destroy->add_option("-n,--name", container_name, "Instance name");
    attach->add_option("-n,--name", container_name, "Instance name");

    CLI11_PARSE(app, argc, argv);

    // Take the realpath of sashi cli exec path.
    {
        std::array<char, PATH_MAX> buffer;
        if (realpath(argv[0], buffer.data()))
        {
            exec_dir = dirname(buffer.data());
        }
        else
        {
            // If real path fails, we get the current dir as exec bin path.
            if (!getcwd(buffer.data(), buffer.size()))
            {
                std::cerr << errno << ": Error in executable path." << std::endl;
                return -1;
            }
            exec_dir = buffer.data();
        }
    }

    // Verifying subcommands.
    if (version->parsed())
    {
        std::cout << "Sashimono CLI version " << version::CLI_VERSION << std::endl;
        return 0;
    }
    else if (status->parsed())
    {
        return execute_cli([]()
                           {
                               std::cout << cli::ctx.socket_path << std::endl;
                               return 0;
                           });
    }
    else if (list->parsed())
    {
        return execute_cli([]()
                           {
                               if (cli::list() == -1)
                               {
                                   std::cerr << "Failed to list instances." << std::endl;
                                   return -1;
                               }
                               return 0;
                           });
    }
    else if (json->parsed() && !json_message.empty())
    {
        return execute_cli([&]()
                           {
                               std::string output;
                               if (cli::get_json_output(json_message, output) == -1)
                                   return -1;

                               std::cout << output << std::endl;
                               return 0;
                           });
    }
    else if (create->parsed() && !contract_id.empty() && !image.empty())
    {
        return execute_cli([&]()
                           { return cli::create(container_name, owner, contract_id, image); });
    }
    else if (start->parsed() && !container_name.empty())
    {
        return execute_cli([&]()
                           { return cli::execute_basic("start", container_name); });
    }
    else if (stop->parsed() && !container_name.empty())
    {
        return execute_cli([&]()
                           { return cli::execute_basic("stop", container_name); });
    }
    else if (destroy->parsed() && !container_name.empty())
    {
        return execute_cli([&]()
                           { return cli::execute_basic("destroy", container_name); });
    }
    else if (attach->parsed() && !container_name.empty())
    {
        return execute_cli([&]()
                           { return cli::docker_exec("attach", container_name); });
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