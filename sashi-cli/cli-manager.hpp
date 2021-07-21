#ifndef _CLI_MANAGER_
#define _CLI_MANAGER_

namespace cli
{
    extern std::string exec_dir; // Path of the Sashi CLI executable, this with be populated from main method args.

    int init();

    int get_socket_path(std::string &socket_path);

    int write_to_socket(std::string_view message);

    int read_from_socket(std::string &message);

    void deinit();
}

#endif
