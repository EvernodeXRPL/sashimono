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
            if (util::create_dir_tree_recursive(ctx.config_dir) == -1 ||
                util::create_dir_tree_recursive(ctx.log_dir) == -1 ||
                util::create_dir_tree_recursive(ctx.data_dir) == -1)
            {
                std::cerr << "ERROR: unable to create directories.\n";
                return -1;
            }
        }

        // Create config file with default settings.
        // We populate the in-memory struct with default settings and then save it to the file.
        {
            sa_config cfg = {};

            cfg.version = "0.0.1";
            cfg.hp.init_peer_port = 22861;
            cfg.hp.init_user_port = 8081;
            cfg.server.ip_port = {};

            cfg.system.max_instance_count = 10;
            cfg.system.max_mem_bytes = cfg.system.max_instance_count * 50 * 1024 * 1024;      // 50MB per instance, Minimum allowed by single docker image is 6MB
            cfg.system.max_cpu_micro_seconds = cfg.system.max_instance_count * 1000000;       // CPU cfs period can not be less than 1ms (i.e. 1000) or larger than 1s (i.e. 1000000);
            cfg.system.max_storage_bytes = cfg.system.max_instance_count * 100 * 1024 * 1024; // 100MB per instance.

            cfg.log.max_file_count = 50;
            cfg.log.max_mbytes_per_file = 10;
            cfg.log.log_level = "inf";
            cfg.log.loggers.emplace("console");
            cfg.log.loggers.emplace("file");

            // Save the default settings into the config file.
            if (write_config(cfg) != 0)
                return -1;
        }

        std::cout << "Config file created at " << ctx.config_file << std::endl;

        return 0;
    }

    /**
     * Updates the context with directory paths based on provided executable path.
     * This is called after parsing SA command line arg in order to populate the ctx.
     * @param exepath Path to executable.
     */
    void set_dir_paths(std::string exepath)
    {
        if (exepath.empty())
        {
            // This code branch will never execute the way main is currently coded, but it might change in future
            std::cerr << "Executeble path must be specified\n";
            exit(1);
        }

        // resolving the path through realpath will remove any trailing slash if present
        exepath = util::realpath(exepath);

        // Take the parent directory path.
        ctx.exe_dir = dirname(exepath.data());
        ctx.hpws_exe_path = ctx.exe_dir + "/hpws";
        ctx.hpfs_exe_path = ctx.exe_dir + "/hpfs";
        ctx.user_install_sh = ctx.exe_dir + "/user-install.sh";
        ctx.user_uninstall_sh = ctx.exe_dir + "/user-uninstall.sh";

        const std::string sashimono_folder = "/etc/sashimono";
        ctx.default_contract_path = sashimono_folder + "/default_contract";
        ctx.config_dir = sashimono_folder + "/cfg";
        ctx.config_file = ctx.config_dir + "/sa.cfg";
        ctx.log_dir = sashimono_folder + "/log";
        ctx.data_dir = sashimono_folder + "/data";
    }

    /**
     * Checks for the existence of all contract sub directories.
     * @return 0 for successful validation. -1 for failure.
     */
    int validate_dir_paths()
    {
        const std::string paths[7] = {
            ctx.config_file,
            ctx.log_dir,
            ctx.data_dir,
            ctx.hpws_exe_path,
            ctx.default_contract_path,
            ctx.user_install_sh,
            ctx.user_uninstall_sh};

        for (const std::string &path : paths)
        {
            if (!util::is_file_exists(path) && !util::is_dir_exists(path))
            {
                if (path == ctx.config_file)
                    std::cerr << path << " does not exist. Initialize with <sagent new> command.\n";
                else if (path == ctx.hpws_exe_path)
                    std::cerr << path << " binary does not exist.\n";
                else
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

        {
            jpath = "hp";

            try
            {
                const jsoncons::ojson &hp = d["hp"];

                cfg.hp.host_address = hp["host_address"].as<std::string>();

                if (cfg.hp.host_address.empty())
                {
                    std::cerr << "Configured hp host_address is empty.\n";
                    return -1;
                }
                
                cfg.hp.init_peer_port = hp["init_peer_port"].as<uint16_t>();
                if (cfg.hp.init_peer_port <= 1024)
                {
                    std::cerr << "Configured init peer port invalid. Should be greater than 1024\n";
                    return -1;
                }

                cfg.hp.init_user_port = hp["init_user_port"].as<uint16_t>();
                if (cfg.hp.init_user_port <= 1024)
                {
                    std::cerr << "Configured init user port invalid. Should be greater than 1024\n";
                    return -1;
                }
            }
            catch (const std::exception &e)
            {
                print_missing_field_error(jpath, e);
                return -1;
            }
        }

        // server
        {
            jpath = "server";

            try
            {
                const jsoncons::ojson &server = d["server"];

                cfg.server.ip_port.host_address = server["host"].as<std::string>();
                cfg.server.ip_port.port = server["port"].as<uint16_t>();

                if (cfg.server.ip_port.host_address.empty())
                {
                    std::cerr << "Configured server host_address is empty.\n";
                    return -1;
                }
                else if (cfg.server.ip_port.port <= 0)
                {
                    std::cerr << "Configured server port invalid.\n";
                    return -1;
                }
            }
            catch (const std::exception &e)
            {
                print_missing_field_error(jpath, e);
                return -1;
            }
        }

        // system
        {
            jpath = "system";

            try
            {
                const jsoncons::ojson &system = d["system"];

                cfg.system.max_mem_bytes = system["max_mem_bytes"].as<size_t>();
                cfg.system.max_cpu_micro_seconds = system["max_cpu_micro_seconds"].as<size_t>();
                cfg.system.max_storage_bytes = system["max_storage_bytes"].as<size_t>();
                cfg.system.max_instance_count = system["max_instance_count"].as<size_t>();
            }
            catch (const std::exception &e)
            {
                print_missing_field_error(jpath, e);
                return -1;
            }
        }

        // log
        {
            jpath = "log";

            try
            {
                const jsoncons::ojson &log = d["log"];
                cfg.log.log_level = log["log_level"].as<std::string>();
                cfg.log.log_level_type = get_loglevel_type(cfg.log.log_level);

                cfg.log.max_mbytes_per_file = log["max_mbytes_per_file"].as<size_t>();
                cfg.log.max_file_count = log["max_file_count"].as<size_t>();
                cfg.log.loggers.clear();
                for (auto &v : log["loggers"].array_range())
                    cfg.log.loggers.emplace(v.as<std::string>());
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

        // Hp configs.
        {
            jsoncons::ojson hp_config;
            hp_config.insert_or_assign("host_address", cfg.hp.host_address);
            hp_config.insert_or_assign("init_peer_port", cfg.hp.init_peer_port);
            hp_config.insert_or_assign("init_user_port", cfg.hp.init_user_port);

            d.insert_or_assign("hp", hp_config);
        }

        // Server configs.
        {
            jsoncons::ojson server_config;

            server_config.insert_or_assign("host", cfg.server.ip_port.host_address);
            server_config.insert_or_assign("port", cfg.server.ip_port.port);

            d.insert_or_assign("server", server_config);
        }

        // System configs.
        {
            jsoncons::ojson system_config;

            system_config.insert_or_assign("max_mem_bytes", cfg.system.max_mem_bytes);
            system_config.insert_or_assign("max_cpu_micro_seconds", cfg.system.max_cpu_micro_seconds);
            system_config.insert_or_assign("max_storage_bytes", cfg.system.max_storage_bytes);
            system_config.insert_or_assign("max_instance_count", cfg.system.max_instance_count);

            d.insert_or_assign("system", system_config);
        }

        // Log configs.
        {
            jsoncons::ojson log_config;
            log_config.insert_or_assign("log_level", cfg.log.log_level);
            log_config.insert_or_assign("max_mbytes_per_file", cfg.log.max_mbytes_per_file);
            log_config.insert_or_assign("max_file_count", cfg.log.max_file_count);

            jsoncons::ojson loggers(jsoncons::json_array_arg);
            for (std::string_view logger : cfg.log.loggers)
            {
                loggers.push_back(logger);
            }
            log_config.insert_or_assign("loggers", loggers);
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