#ifndef _CLI_MANAGER_
#define _CLI_MANAGER_

namespace cli
{
    struct cli_context
    {
        std::string sashi_dir;     // Path of the Sashi CLI executable.
        std::string sashimono_dir; // Path of the Sashimono executable.
        std::string socket_path;   // Path of the sashimono socket.
        int socket_fd = -1;        // File descriptor of the socket.
    };

    extern cli_context ctx;

    int init(std::string_view sashi_dir);

    int get_socket_path(std::string &socket_path);

    int get_bin_path(std::string &bin_path);

    int write_to_socket(std::string_view message);

    int read_from_socket(std::string &message);

    int get_json_output(std::string_view msg, std::string &output);

    int execute_basic(std::string_view type, std::string_view container_name);

    int create(std::string_view container_name, std::string_view owner, std::string_view contract_id, std::string_view image);

    int list();

    int docker_exec(std::string_view type, std::string_view container_name);

    void print_to_table(const jsoncons::json &list, const std::vector<std::pair<std::string, std::string>> &columns);

    const std::string value_to_string(const jsoncons::json &val);

    void deinit();
    
    uint32_t uint32_from_bytes(const uint8_t *data);
}

#endif
