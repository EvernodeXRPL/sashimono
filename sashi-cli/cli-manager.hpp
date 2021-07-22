#ifndef _CLI_MANAGER_
#define _CLI_MANAGER_

namespace cli
{
    struct cli_context
    {
        std::string sashi_dir;   // Path of the Sashi CLI executable, this with be populated from main method args.
        std::string socket_path; // Path of the sashimono socket.
        int socket_fd = -1;      // File descriptor of the socket.
    };

    extern cli_context ctx;

    int init(std::string_view sashi_dir);

    int get_socket_path(std::string &socket_path);

    int write_to_socket(std::string_view message);

    int read_from_socket(std::string &message);

    void deinit();
}

#endif
