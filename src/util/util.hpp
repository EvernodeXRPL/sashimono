#ifndef _HP_UTIL_UTIL_
#define _HP_UTIL_UTIL_

#include "../pchheader.hpp"

/**
 * Contains helper functions and data structures used by multiple other subsystems.
 */
namespace util
{
    constexpr const mode_t DIR_PERMS = 0755;
    struct user_info
    {
        std::string username;
        int user_id;
        int group_id;
        std::string home_dir;
    };

    const std::string to_hex(const std::string_view bin);

    const std::string to_bin(const std::string_view hex);

    bool is_dir_exists(std::string_view path);

    bool is_file_exists(std::string_view path);

    int create_dir_tree_recursive(std::string_view path);

    int read_from_fd(const int fd, std::string &buf, const off_t offset = 0);

    const std::string realpath(std::string_view path);

    void fork_detach();

    void mask_signal();

    void sleep(const uint64_t milliseconds);

    uint64_t get_epoch_milliseconds();

    int remove_directory_recursively(std::string_view dir_path);

    int kill_process(const pid_t pid, const bool wait, const int signal = SIGINT);

    void split_string(std::vector<std::string> &collection, std::string_view str, std::string_view delimeter);

    int stoi(const std::string &str, int &result);

    int stoul(const std::string &str, uint16_t &result);

    int stoull(const std::string &str, uint64_t &result);

    const std::string get_user_contract_dir(const std::string &username, std::string_view container_name);

    int get_system_user_info(std::string_view username, user_info &user_info);

    void find_and_replace(std::string &str, std::string_view find, std::string_view replace);

    int write_json_file(const int fd, const jsoncons::ojson &d);

    int read_json_file(const int fd, jsoncons::ojson &d);

    int execute_bash_file(std::string_view file_name, std::vector<std::string> &output_params, const std::vector<std::string_view> &input_params = {});

    int execute_bash_cmd(const char *command, char *output, const int output_len);

} // namespace util

#endif
