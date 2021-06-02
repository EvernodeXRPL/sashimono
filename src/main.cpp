/**
    Entry point for Sashimono
**/
#include "pchheader.hpp"
#include "conf.hpp"
#include "sqlite.hpp"
#include "salog.hpp"

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
    std::cout << "Example: sagent run\n";

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

        salog::init(); // Initialize logger for SA.

        if (conf::ctx.command == "run")
        {
            LOG_INFO << "Sashimono agent started. Version : " << conf::cfg.version << " Log level : " << conf::cfg.log.log_level;

            // Run the program.

            sqlite3 *db = NULL;
            const char *path = "db.sqlite";

            if (sqlite::open_db(path, &db, true) == -1)
            {
                LOG_ERROR << "Error opening database";
                return -1;
            }
            LOG_INFO << "Database " << path << " opened successfully";

            const std::vector<sqlite::table_column_info> column_info{
                sqlite::table_column_info("VERSION", sqlite::COLUMN_DATA_TYPE::TEXT)};

            if (create_table(db, "SA_VERSION", column_info) == -1)
                return -1;

            if (sqlite::insert_row(db, "SA_VERSION", "VERSION", "\"0.0.0\"") == -1)
                return -1;

            if (sqlite::close_db(&db) == -1)
            {
                LOG_ERROR << "Error closing database";
                return -1;
            }
        }
        else if (conf::ctx.command == "version")
            // Print the version
            LOG_INFO << "Sashimono Agent " << conf::cfg.version;

        deinit();
    }

    LOG_INFO << "sashimono agent exited normally.";
    return 0;
}
