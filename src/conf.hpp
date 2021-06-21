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

    struct host_ip_port
    {
        std::string host_address;
        uint16_t port = 0;

        bool operator==(const host_ip_port &other) const
        {
            return host_address == other.host_address && port == other.port;
        }

        bool operator!=(const host_ip_port &other) const
        {
            return !(host_address == other.host_address && port == other.port);
        }

        bool operator<(const host_ip_port &other) const
        {
            return (host_address == other.host_address) ? port < other.port : host_address < other.host_address;
        }

        const std::string to_string() const
        {
            return host_address + ":" + std::to_string(port);
        }
    };

    struct log_config
    {
        std::string log_level;                   // Log severity level (dbg, inf, wrn, wrr)
        LOG_SEVERITY log_level_type;             // Log severity level enum (debug, info, warn, error)
        std::unordered_set<std::string> loggers; // List of enabled loggers (console, file)
        size_t max_mbytes_per_file = 0;          // Max MB size of a single log file.
        size_t max_file_count = 0;               // Max no. of log files to keep.
    };

    struct server_config
    {
        host_ip_port ip_port;
    };

    struct hp_config
    {
        uint16_t init_peer_port;
        uint16_t init_user_port;
    };

    struct system_config
    {
        size_t max_cpu_micro_seconds = 0; // Max CPU time the agent process can consume.
        size_t max_mem_bytes = 0;         // Max memory the agent process can allocate.
        size_t max_storage_bytes = 0;     // Max physical storage the agent process can allocate.
        size_t max_instance_count = 0;    // Max number of instances that can be created.
    };

    struct sa_config
    {
        std::string version;
        hp_config hp;
        server_config server;
        system_config system;
        log_config log;
    };

    struct sa_context
    {
        std::string command;               // The CLI command issued to launch Sashimono agent
        std::string exe_dir;               // Hot Pocket executable dir.
        std::string hpws_exe_path;         // hpws executable file path.
        std::string hpfs_exe_path;         // hpfs executable file path.
        std::string default_contract_path; // Path to default contract.

        std::string user_install_sh;
        std::string user_uninstall_sh;
        
        std::string config_dir;  // Config dir full path.
        std::string config_file; // Full path to the config file.
        std::string log_dir;     // Log directory full path.
        std::string data_dir;    // Data directory full path.
    };

    // Global context struct exposed to the application.
    // Other modules will access context values via this.
    extern sa_context ctx;

    // Global configuration struct exposed to the application.
    // Other modules will access config values via this.
    extern sa_config cfg;

    int init();

    int create();

    void set_dir_paths(std::string exepath);

    int validate_dir_paths();

    int read_config(sa_config &cfg);

    int write_config(const sa_config &cfg);

    int write_json_file(const std::string &file_path, const jsoncons::ojson &d);

    LOG_SEVERITY get_loglevel_type(std::string_view severity);

    void print_missing_field_error(std::string_view jpath, const std::exception &e);

    int validate_config(const sa_config &cfg);

}

#endif