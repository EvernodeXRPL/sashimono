#ifndef _SA_CONF_
#define _SA_CONF_

#include "pchheader.hpp"

namespace conf
{
    // Log severity levels used in Sashimono agent.
    enum LOG_SEVERITY
    {
        DEBUG,
        INFO,
        WARN,
        ERROR
    };

    struct log_config
    {
        std::string log_level;       // Log severity level (dbg, inf, wrn, wrr)
        LOG_SEVERITY log_level_type; // Log severity level enum (debug, info, warn, error)
    };

    struct sa_config
    {
        std::string version;
        log_config log;
    };

    struct sa_context
    {
        std::string command; // The CLI command issued to launch Sashimono agent
        
        std::string config_dir;  // Config dir full path.
        std::string config_file; // Full path to the config file.
    };

    // Global context struct exposed to the application.
    // Other modules will access context values via this.
    extern sa_context ctx;

    // Global configuration struct exposed to the application.
    // Other modules will access config values via this.
    extern sa_config cfg;

    int init();

    void deinit();

    int create();

    void set_dir_paths(std::string_view exepath);

    int validate_dir_paths();

    int read_config(sa_config &cfg);

    int write_config(const sa_config &cfg);

    int write_json_file(const std::string &file_path, const jsoncons::ojson &d);

    LOG_SEVERITY get_loglevel_type(std::string_view severity);

    void print_missing_field_error(std::string_view jpath, const std::exception &e);

    int validate_config(const sa_config &cfg);

}

#endif