/**
    Entry point for Sashimono
**/
#include "pchheader.hpp"
#include "conf.hpp"

/**
 * Parses CLI args and extracts sashimono agent command and parameters given.
 * @param argc Argument count.
 * @param argv Arguments.
 * @returns 0 on success, -1 on error.
 */
int parse_cmd(int argc, char **argv)
{
    conf::ctx.command = argv[1];
    if (argc == 2 && //We get working dir as an arg anyway. So we need to check for ==2 args.
        (conf::ctx.command == "new" || conf::ctx.command == "run" || conf::ctx.command == "version"))
    {
        // We populate the global contract ctx with the detected command.
        conf::set_dir_paths(argv[0]);
        return 0;
    }

    // If all extractions fail display help message.
    std::cerr << "Arguments mismatch.\n";
    std::cout << "Usage:\n";
    std::cout << "sagent version\n";
    std::cout << "sagent <command> (command = run | new | rekey)\n";
    std::cout << "Example: hpcore run\n";

    return -1;
}

/**
 * Performs any cleanup on graceful application termination.
 */
void deinit()
{
    conf::deinit();
}

int main(int argc, char **argv)
{
    // Extract the CLI args
    // This call will populate conf::ctx
    if (parse_cmd(argc, argv) != 0)
        return -1;

    if (conf::ctx.command == "new")
    {
        // This will create a new config.
        if (conf::create() != 0)
            return -1;
    }
    else
    {
        if (conf::init() != 0)
            return -1;

        if (conf::ctx.command == "run")
        {
            std::cout << "Sashimono agent started. Version : " << conf::cfg.version << " Log level : " << conf::cfg.log.log_level << std::endl;

            // Run the program.

            std::cout << "Sashimono agent ended." << std::endl;
        }
        else if (conf::ctx.command == "version")
        {
            // Print the version
            std::cout << "Sashimono Agent " << conf::cfg.version << std::endl;
        }

        deinit();
    }

    return 0;
}
