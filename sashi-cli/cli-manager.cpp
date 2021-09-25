#include "pchheader.hpp"
#include "cli-manager.hpp"

namespace cli
{
    constexpr const char *SOCKET_NAME = "sa.sock";     // Name of the sashimono socket.
    constexpr const char *DATA_DIR = "/etc/sashimono"; // Sashimono data directory.
    constexpr const int BUFFER_SIZE = 4096;            // Max read buffer size.
    constexpr const char *LIST_FORMATTER_STR = "%-38s%-27s%-10s%-10s%-10s%s\n";
    constexpr const char *MSG_LIST = "{\"type\": \"list\"}";
    constexpr const char *MSG_BASIC = "{\"type\":\"%s\",\"container_name\":\"%s\"}";

    cli_context ctx;

    bool init_success = false;

    /**
     * Initialize the socket and connect.
     * @return 0 on success, -1 on error.
    */
    int init(std::string_view sashi_dir)
    {
        ctx.sashi_dir = sashi_dir;

        // Get the socket path from available location.
        if (get_socket_path(ctx.socket_path) == -1)
            return -1;

        // Create the seq paket socket.
        ctx.socket_fd = socket(AF_UNIX, SOCK_SEQPACKET, 0);
        if (ctx.socket_fd == -1)
        {
            std::cerr << errno << " :Error while creating the sashimono socket.\n";
            return -1;
        }

        struct sockaddr_un addr;
        memset(&addr, 0, sizeof(struct sockaddr_un));

        addr.sun_family = AF_UNIX;
        strncpy(addr.sun_path, ctx.socket_path.data(), sizeof(addr.sun_path) - 1);

        if (connect(ctx.socket_fd, (const struct sockaddr *)&addr, sizeof(struct sockaddr_un)) == -1)
        {
            // If permission denied, show a custom error.
            if (errno == EACCES)
                std::cerr << "Permission denied: Only root or users in 'sashiadmin' group can access the sashimono socket.\n";
            else
                std::cerr << errno << " :Error while connecting to the sashimono socket.\n";
            close(ctx.socket_fd);
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
        std::string path = ctx.sashi_dir + std::string("/") + SOCKET_NAME;
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

        if (write(ctx.socket_fd, message.data(), message.size()) == -1)
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
        const int res = read(ctx.socket_fd, message.data(), message.length());
        if (res == -1)
        {
            std::cerr << errno << " :Error while reading from the sashimono socket.\n";
            return -1;
        }
        message.resize(res);

        return res;
    }

    int get_json_output(std::string_view json_msg, std::string &output)
    {
        if (write_to_socket(json_msg) == -1 || read_from_socket(output) == -1)
            return -1;

        return 0;
    }

    int execute_basic(std::string_view type, std::string_view container_name)
    {
        std::string msg, output;
        msg.resize(31 + type.size() + container_name.size());
        sprintf(msg.data(), MSG_BASIC, type.data(), container_name.data());

        const int ret = get_json_output(msg, output);
        if (ret == 0)
            std::cout << output << std::endl;
        return ret;
    }

    /**
     * Print the list of instances in a tabular manner.
     * @return 0 on success, -1 on error.
    */
    int list()
    {
        std::string output;
        if (get_json_output(MSG_LIST, output) == -1)
            return -1;

        try
        {
            jsoncons::json d = jsoncons::json::parse(output, jsoncons::strict_json_parsing());
            if (!d.contains("type") ||
                d["type"].as<std::string>() != "list_res" ||
                !d.contains("content") ||
                !d["content"].is_array())
            {
                std::cerr << "Invalid response. " << jsoncons::pretty_print(d) << std::endl;
                return -1;
            }

            printf(LIST_FORMATTER_STR, "Name", "User", "UserPort", "MeshPort", "Status", "Image");
            printf(LIST_FORMATTER_STR, "====", "====", "========", "========", "======", "=====");

            for (const auto &instance : d["content"].array_range())
            {
                printf(LIST_FORMATTER_STR,
                       instance["name"].as<std::string_view>().data(),
                       instance["user"].as<std::string_view>().data(),
                       std::to_string(instance["user_port"].as<uint16_t>()).c_str(),
                       std::to_string(instance["peer_port"].as<uint16_t>()).c_str(),
                       instance["status"].as<std::string_view>().data(),
                       instance["image"].as<std::string_view>().data());
            }
        }
        catch (const std::exception &e)
        {
            std::cerr << "JSON message parsing failed. " << e.what() << std::endl;
            return -1;
        }

        return 0;
    }

    /**
     * Close the socket and deinitialize.
    */
    void deinit()
    {
        if (init_success)
            close(ctx.socket_fd);
    }
}