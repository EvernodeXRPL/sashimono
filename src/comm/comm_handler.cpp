#include "comm_handler.hpp"
#include "../util/util.hpp"
#include "../conf.hpp"

#define __HANDLE_RESPONSE(type, content, ret)                                                                                          \
    {                                                                                                                                  \
        std::string res;                                                                                                               \
        msg_parser.build_response(res, type, content, (type == msg::MSGTYPE_CREATE_RES || type == msg::MSGTYPE_LIST_RES) && ret == 0); \
        send(res);                                                                                                                     \
        return ret;                                                                                                                    \
    }

namespace comm
{
    constexpr uint32_t DEFAULT_MAX_MSG_SIZE = 1 * 1024 * 1024; // 1MB;
    bool init_success;
    constexpr const int POLL_TIMEOUT = 10;
    constexpr const int BUFFER_SIZE = 4096;
    constexpr const int EMPTY_READ_TRESHOLD = 5;
    msg::msg_parser msg_parser;
    std::vector<uint8_t> read_buffer(BUFFER_SIZE, 0); // Global buffer storing the current message.

    comm_ctx ctx;

    int init()
    {
        ctx.connection_socket = socket(AF_UNIX, SOCK_SEQPACKET, 0);
        if (ctx.connection_socket == -1)
        {
            LOG_ERROR << errno << ": Error creating the socket.";
            return -1;
        }
        struct sockaddr_un sock_name;
        memset(&sock_name, 0, sizeof(struct sockaddr_un));

        sock_name.sun_family = AF_UNIX;
        strncpy(sock_name.sun_path, conf::ctx.socket_path.c_str(), sizeof(sock_name.sun_path) - 1);

        // Remove the socket if it already exists.
        unlink(conf::ctx.socket_path.c_str());

        const std::string command = "chown :sashiadmin " + conf::ctx.socket_path;

        const mode_t permission_mode = 0660; // rw-rw----

        if (bind(ctx.connection_socket, (const struct sockaddr *)&sock_name, sizeof(struct sockaddr_un)) == -1 ||
            chmod(conf::ctx.socket_path.c_str(), permission_mode) == -1 ||
            system(command.data()) == -1 ||
            listen(ctx.connection_socket, 20) == -1)
        {
            LOG_ERROR << errno << ": Error binding the socket for " << conf::ctx.socket_path;
            close(ctx.connection_socket);
            return -1;
        }

        msg_parser = msg::msg_parser();
        ctx.comm_handler_thread = std::thread(comm_handler_loop);
        init_success = true;

        return 0;
    }

    void deinit()
    {
        if (init_success)
        {
            ctx.is_shutting_down = true;

            if (ctx.comm_handler_thread.joinable())
                ctx.comm_handler_thread.join();

            close(ctx.connection_socket);
            unlink(conf::ctx.socket_path.c_str());
        }
    }

    /**
     * This accepts connections to the socket.
     * This only gets called whithin the comm handler thread.
     * @return 0 on success -1 on error.
    */
    int connect()
    {
        ctx.data_socket = accept(ctx.connection_socket, NULL, NULL);
        if (ctx.data_socket == -1)
        {
            LOG_ERROR << errno << ": Error accepting the new connection.";
            return -1;
        }
        return 0;
    }

    /**
     * Disconnect the session.
     * This only gets called whithin the comm handler thread.
    */
    void disconnect()
    {
        close(ctx.data_socket);
        ctx.data_socket = -1;
    }

    void comm_handler_loop()
    {
        LOG_INFO << "Message processor started.";

        util::mask_signal();
        struct pollfd pfd;
        int empty_read_count = 0; // Helps to detect when the client is disconnected.

        while (!ctx.is_shutting_down)
        {
            // Process queued messaged only if there's a socket connection.
            if (ctx.data_socket != -1)
            {
                const int message_size = read_socket();
                if (message_size == -1)
                    disconnect();
                else if (message_size > 0)
                    handle_message(message_size);
                else
                {
                    empty_read_count++;
                    // Empty reads happens when client closed the connection.
                    // Disconnect connection after 5 consecutive empty reads.
                    if (empty_read_count == EMPTY_READ_TRESHOLD)
                    {
                        disconnect();
                        empty_read_count = 0;
                    }
                    util::sleep(1000);
                }
            }
            else
            {
                pfd.fd = ctx.connection_socket;
                pfd.events = POLLIN;

                // Wait for some time if no connections are available.
                if (poll(&pfd, 1, POLL_TIMEOUT) > 0)
                {
                    connect();
                    empty_read_count = 0;
                }
                else
                    util::sleep(1000);
            }
        }

        // Disconnect the host at the termination.
        disconnect();

        LOG_INFO << "Message processor stopped.";
    }

    /**
     * Wait for the comm handler thread.
     */
    void wait()
    {
        ctx.comm_handler_thread.join();
    }

    /**
     * Handles the received message.
     * @param message_size Message size.
     * @return 0 on success -1 on error.
    */
    int handle_message(const int message_size)
    {
        std::string_view msg((char *)read_buffer.data(), message_size);
        std::string type;
        if (msg_parser.parse(msg) == -1 || msg_parser.extract_type(type) == -1)
        {
            read_buffer.clear();
            __HANDLE_RESPONSE("error", "format_error", -1);
        }

        // Clear the buffer after the message is parsed.
        read_buffer.clear();

        if (type == msg::MSGTYPE_LIST)
        {
            std::vector<hp::instance_info> instances;
            hp::get_instance_list(instances);
            std::string list_res;
            msg_parser.build_list_response(list_res, instances);
            __HANDLE_RESPONSE(msg::MSGTYPE_LIST_RES, list_res, 0);
        }
        else if (type == msg::MSGTYPE_CREATE)
        {
            msg::create_msg msg;
            if (msg_parser.extract_create_message(msg) == -1)
                __HANDLE_RESPONSE(msg::MSGTYPE_CREATE_RES, "format_error", -1);

            hp::instance_info info;
            if (hp::create_new_instance(info, msg.pubkey, msg.contract_id, msg.image) == -1)
                __HANDLE_RESPONSE(msg::MSGTYPE_CREATE_RES, "create_error", -1);

            std::string create_res;
            msg_parser.build_create_response(create_res, info);
            __HANDLE_RESPONSE(msg::MSGTYPE_CREATE_RES, create_res, 0);
        }
        else if (type == msg::MSGTYPE_INITIATE)
        {
            msg::initiate_msg msg;
            if (msg_parser.extract_initiate_message(msg) == -1)
                __HANDLE_RESPONSE(msg::MSGTYPE_INITIATE_RES, "format_error", -1);

            if (hp::initiate_instance(msg.container_name, msg) == -1)
                __HANDLE_RESPONSE(msg::MSGTYPE_INITIATE_RES, "init_error", -1);

            __HANDLE_RESPONSE(msg::MSGTYPE_INITIATE_RES, "initiated", 0);
        }
        else if (type == msg::MSGTYPE_DESTROY)
        {
            msg::destroy_msg msg;
            if (msg_parser.extract_destroy_message(msg))
                __HANDLE_RESPONSE(msg::MSGTYPE_DESTROY_RES, "format_error", -1);

            if (hp::destroy_container(msg.container_name) == -1)
                __HANDLE_RESPONSE(msg::MSGTYPE_DESTROY_RES, "destroy_error", -1);

            __HANDLE_RESPONSE(msg::MSGTYPE_DESTROY_RES, "destroyed", 0);
        }
        else if (type == msg::MSGTYPE_START)
        {
            msg::start_msg msg;
            if (msg_parser.extract_start_message(msg))
                __HANDLE_RESPONSE(msg::MSGTYPE_START_RES, "format_error", -1);

            if (hp::start_container(msg.container_name) == -1)
                __HANDLE_RESPONSE(msg::MSGTYPE_START_RES, "start_error", -1);

            __HANDLE_RESPONSE(msg::MSGTYPE_START_RES, "started", 0);
        }
        else if (type == msg::MSGTYPE_STOP)
        {
            msg::stop_msg msg;
            if (msg_parser.extract_stop_message(msg))
                __HANDLE_RESPONSE(msg::MSGTYPE_STOP_RES, "format_error", -1);

            if (hp::stop_container(msg.container_name) == -1)
                __HANDLE_RESPONSE(msg::MSGTYPE_STOP_RES, "stop_error", -1);

            __HANDLE_RESPONSE(msg::MSGTYPE_STOP_RES, "stopped", 0);
        }
        else
            __HANDLE_RESPONSE("error", "type_error", -1);

        return 0;
    }

    /**
     * Sends the given message to the connected client.
     * @param message Message to send.
     * @return 0 on success -1 on error.
     **/
    int send(std::string_view message)
    {
        if (ctx.data_socket == -1)
            return -1;

        const int ret = write(ctx.data_socket, message.data(), message.length());
        // Close connection after sending the response to the client.
        disconnect();
        return ret == -1 ? -1 : 0;
    }

    /**
     * Reads the message from the connected client to the global buffer.
     * @return Number of bytes read on success -1 on error.
     **/
    int read_socket()
    {
        const int ret = read(ctx.data_socket, read_buffer.data(), BUFFER_SIZE);
        if (ret == -1)
        {
            LOG_ERROR << errno << ": Error receiving data.";
            return -1;
        }
        return ret;
    }
} // namespace comm
