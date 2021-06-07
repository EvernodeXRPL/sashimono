#ifndef _HP_UTIL_UTIL_
#define _HP_UTIL_UTIL_

#include "../pchheader.hpp"

/**
 * Contains helper functions and data structures used by multiple other subsystems.
 */
namespace util
{
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

} // namespace util

#endif
