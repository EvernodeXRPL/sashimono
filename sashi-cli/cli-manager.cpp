#include "pchheader.hpp"
#include "cli-manager.hpp"

namespace cli
{
    constexpr const char *SOCKET_NAME = "sa.sock";     // Name of the sashimono socket.
    constexpr const char *DATA_DIR = "/etc/sashimono"; // Sashimono data directory.
    constexpr const int BUFFER_SIZE = 1024;            // Max read buffer size.

    bool init_success = false;
    int socket_fd = -1;
    std::string exec_dir;

    /**
     * Initialize the socket and connect.
     * @return 0 on success, -1 on error.
    */
    int init()
    {
        // Get the socket path from available location.
        std::string socket_path;
        if (get_socket_path(socket_path) == -1)
            return -1;

        // Create the seq paket socket.
        socket_fd = socket(AF_UNIX, SOCK_SEQPACKET, 0);
        if (socket_fd == -1)
        {
            std::cerr << errno << " :Error while creating the sashimono socket.\n";
            return -1;
        }

        struct sockaddr_un addr;
        memset(&addr, 0, sizeof(struct sockaddr_un));

        addr.sun_family = AF_UNIX;
        strncpy(addr.sun_path, socket_path.data(), sizeof(addr.sun_path) - 1);

        if (connect(socket_fd, (const struct sockaddr *)&addr, sizeof(struct sockaddr_un)) == -1)
        {
            // If permission denied, show a custom error.
            if (errno == EACCES)
                std::cerr << "Permission denied: Only root or users in 'sashiadmin' group can access the sashimono socket.\n";
            else
                std::cerr << errno << " :Error while connecting to the sashimono socket.\n";
            close(socket_fd);
            return -1;
        }

        init_success = true;
        return 0;
    }

    /**
     * Locate and return the sashimono agent socket path according predefined rules.
     * If sa.sock found on the same path as the cli binary, use that. (to support dev testing)
     * Else sa.sock found on /etc/sashimono, use that.
     * Else show error.
     * @param socket_path Socket path to be populated.
     * @return 0 on success, -1 on error.
    */
    int get_socket_path(std::string &socket_path)
    {
        // Check whether socket exists in exec path.
        std::string path = exec_dir + std::string("/") + SOCKET_NAME;
        struct stat st;
        if (stat(path.data(), &st) == 0 && S_ISSOCK(st.st_mode))
        {
            socket_path = path;
            return 0;
        }

        // Otherwise check in the data dir.
        path = DATA_DIR + std::string("/") + SOCKET_NAME;
        memset(&st, 0, sizeof(struct stat));
        if (stat(path.data(), &st) == 0 && S_ISSOCK(st.st_mode))
        {
            socket_path = path;
            return 0;
        }

        std::cerr << SOCKET_NAME << " is not found.\n";
        return -1;
    }

    /**
     * Write a given message into the sashimono socket.
     * @param message Message to be write.
     * @return 0 on success, -1 on error.
    */
    int write_to_socket(std::string_view message)
    {
        if (!init_success)
        {
            std::cerr << "Sashimono socket is not initialized.\n";
            return -1;
        }

        if (write(socket_fd, message.data(), message.size()) == -1)
        {
            std::cerr << errno << " :Error while wrting to the sashimono socket.\n";
            return -1;
        }

        return 0;
    }

    /**
     * Read message from the sashimono socket.
     * @param message Message to be read.
     * @return Read message length on success, -1 on error.
    */
    int read_from_socket(std::string &message)
    {
        if (!init_success)
        {
            std::cerr << "Sashimono socket is not initialized.\n";
            return -1;
        }

        // Resize the message to max length and resize to original read length after reading.
        message.resize(BUFFER_SIZE);
        const int res = read(socket_fd, message.data(), message.length());
        if (res == -1)
        {
            std::cerr << errno << " :Error while reading from the sashimono socket.\n";
            return -1;
        }
        message.resize(res);

        return res;
    }

    /**
     * Close the socket and deinitialize.
    */
    void deinit()
    {
        if (init_success)
            close(socket_fd);
    }
}