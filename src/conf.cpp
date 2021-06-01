#include "conf.hpp"
#include "util/util.hpp"

namespace conf
{
    // Global contract context struct exposed to the application.
    sa_context ctx;

    // Global configuration struct exposed to the application.
    sa_config cfg;

    constexpr int FILE_PERMS = 0644;

    bool init_success = false;

    /**
     * Loads and initializes the config for execution. Must be called once during application startup.
     * @return 0 for success. -1 for failure.
     */
    int init()
    {
        if (validate_dir_paths() == -1 ||
            read_config(cfg) == -1 ||
            validate_config(cfg) == -1)
            return -1;

        init_success = true;
        return 0;
    }

    /**
     * Cleanup any resources.
     */
    void deinit()
    {
        if (init_success)
        {
            // Deinit here.
        }
    }

    /**
     * Create config here.
     * @return 0 for success. -1 for failure.
     */
    int create()
    {
        if (util::is_dir_exists(ctx.config_dir))
        {
            if (util::is_file_exists(ctx.config_file))
            {
                std::cerr << "Config file already exists. Cannot create config at the same location.\n";
                return -1;
            }
        }
        else
        {
            // Recursivly create contract directory. Return an error if unable to create
            if (util::create_dir_tree_recursive(ctx.config_dir) == -1)
            {
                std::cerr << "ERROR: unable to create config directory.\n";
                return -1;
            }
        }

        //Create config file with default settings.
        //We populate the in-memory struct with default settings and then save it to the file.
        {
            sa_config cfg = {};

            cfg.version = "0.1";
            cfg.log.log_level = "inf";

            //Save the default settings into the config file.
            if (write_config(cfg) != 0)
                return -1;
        }

        std::cout << "Config file created at " << ctx.config_file << std::endl;

        return 0;
    }

    /**
     * Updates the context with directory paths based on provided base directory.
     * This is called after parsing SA command line arg in order to populate the ctx.
     * @param exepath Path of the execution binary.
     */
    void set_dir_paths(std::string_view exepath)
    {
        if (exepath.empty())
        {
            // This code branch will never execute the way main is currently coded, but it might change in future
            std::cerr << "a execution directory must be specified\n";
            exit(1);
        }

        // Resolving the path through realpath will remove any trailing slash if present
        // Set config directory to the parent of the exec binary.
        ctx.config_dir = dirname((char *)util::realpath(exepath).data());
        ctx.config_dir.append("/cfg");
        ctx.config_file = ctx.config_dir;
        ctx.config_file.append("/sa.cfg");
    }

    /**
     * Checks for the existence of all contract sub directories.
     * @return 0 for successful validation. -1 for failure.
     */
    int validate_dir_paths()
    {
        const std::string paths[1] = {
            ctx.config_file};

        for (const std::string &path : paths)
        {
            if (!util::is_file_exists(path) && !util::is_dir_exists(path))
            {
                std::cerr << path << " does not exist.\n";
                return -1;
            }
        }

        return 0;
    }

    /**
     * Reads the config file on disk and populates the in-memory 'cfg' struct.
     * @param cfg Config to populate.
     * @return 0 for successful loading of config. -1 for failure.
     */
    int read_config(sa_config &cfg)
    {
        int fd = open(ctx.config_file.data(), O_RDWR, 444);
        if (fd == -1)
            return -1;

        // Read the config file into json document object.
        std::string buf;
        if (util::read_from_fd(fd, buf) == -1)
        {
            std::cerr << "Error reading from the config file. " << errno << '\n';
            return -1;
        }

        jsoncons::ojson d;
        try
        {
            d = jsoncons::ojson::parse(buf, jsoncons::strict_json_parsing());
        }
        catch (const std::exception &e)
        {
            std::cerr << "Invalid config file format. " << e.what() << '\n';
            return -1;
        }
        buf.clear();

        try
        {
            // Check whether the version is specified.
            cfg.version = d["version"].as<std::string>();
            if (cfg.version.empty())
            {
                std::cerr << "Config version missing.\n";
                return -1;
            }
        }
        catch (const std::exception &e)
        {
            std::cerr << "Required config field version missing at " << ctx.config_file << std::endl;
            return -1;
        }

        std::string jpath;

        // log
        {
            jpath = "log";

            try
            {
                const jsoncons::ojson &log = d["log"];
                cfg.log.log_level = log["log_level"].as<std::string>();
                cfg.log.log_level_type = get_loglevel_type(cfg.log.log_level);
            }
            catch (const std::exception &e)
            {
                print_missing_field_error(jpath, e);
                return -1;
            }
        }

        return 0;
    }

    /**
     * Saves the provided 'cfg' struct into the config file.
     * @param cfg Config to write.
     * @return 0 for successful save. -1 for failure.
     */
    int write_config(const sa_config &cfg)
    {
        // Popualte json document with 'cfg' values.
        // ojson is used instead of json to preserve insertion order.
        jsoncons::ojson d;
        d.insert_or_assign("version", cfg.version);

        // Log configs.
        {
            jsoncons::ojson log_config;
            log_config.insert_or_assign("log_level", cfg.log.log_level);
            d.insert_or_assign("log", log_config);
        }

        return write_json_file(ctx.config_file, d);
    }

    /**
     * Writes the given json doc to a file.
     * @param file_path Path to the file.
     * @param d Json object.
     * @return 0 on success. -1 on failure.
     */
    int write_json_file(const std::string &file_path, const jsoncons::ojson &d)
    {
        std::string json;
        // Convert json object to a string.
        try
        {
            jsoncons::json_options options;
            options.object_array_line_splits(jsoncons::line_split_kind::multi_line);
            options.spaces_around_comma(jsoncons::spaces_option::no_spaces);
            std::ostringstream os;
            os << jsoncons::pretty_print(d, options);
            json = os.str();
            os.clear();
        }
        catch (const std::exception &e)
        {
            std::cerr << "Converting json to string failed. " << file_path << std::endl;
            return -1;
        }

        // O_TRUNC flag is used to trucate existing content from the file.
        const int fd = open(file_path.data(), O_CREAT | O_RDWR | O_TRUNC, FILE_PERMS);
        if (fd == -1 || write(fd, json.data(), json.size()) == -1)
        {
            std::cerr << "Writing file failed. " << file_path << std::endl;
            if (fd != -1)
                close(fd);
            return -1;
        }
        close(fd);
        return 0;
    }

    /**
     * Convert string to Log Severity enum type.
     * @param severity log severity code.
     * @return log severity type.
    */
    LOG_SEVERITY get_loglevel_type(std::string_view severity)
    {
        if (severity == "dbg")
            return LOG_SEVERITY::DEBUG;
        else if (severity == "wrn")
            return LOG_SEVERITY::WARN;
        else if (severity == "inf")
            return LOG_SEVERITY::INFO;
        else
            return LOG_SEVERITY::ERROR;
    }

    /**
     * Prints the config json parsing field missing error.
     * @param jpath Json path of the feild.
     * @param e Exception.
     */
    void print_missing_field_error(std::string_view jpath, const std::exception &e)
    {
        // Extract field name from jsoncons exception message.
        std::cerr << "Config validation error: " << e.what() << " in '" << jpath << "' section at " << ctx.config_file << std::endl;
    }

    /**
     * Validates the 'cfg' struct for invalid values.
     * @param cfg Config to validate.
     * @return 0 for successful validation. -1 for failure.
     */
    int validate_config(const sa_config &cfg)
    {
        // Other required fields.

        bool fields_invalid = false;
        fields_invalid |= cfg.log.log_level.empty() && std::cerr << "Invalid value for loglevel.\n";

        if (fields_invalid)
        {
            std::cerr << "Invalid configuration values at " << ctx.config_file << std::endl;
            return -1;
        }

        const std::unordered_set<std::string> valid_loglevels({"dbg", "inf", "wrn", "err"});
        if (valid_loglevels.count(cfg.log.log_level) != 1)
        {
            std::cerr << "Invalid loglevel configured. Valid values: dbg|inf|wrn|err\n";
            return -1;
        }

        return 0;
    }

}