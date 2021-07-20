#include "comm_handler.hpp"
#include "../util/util.hpp"
#include "../conf.hpp"
#include "hpws.hpp"

namespace comm
{
    constexpr uint32_t DEFAULT_MAX_MSG_SIZE = 1 * 1024 * 1024; // 1MB;
    bool init_success;
    constexpr const int POLL_TIMEOUT = 10;


    comm_ctx ctx;

    int init()
    {
        ctx.comm_handler_thread = std::thread(comm_handler_loop);

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

        unlink(conf::ctx.socket_path.c_str());

        if (bind(ctx.connection_socket, (const struct sockaddr *)&sock_name, sizeof(struct sockaddr_un)) == -1 ||
            listen(ctx.connection_socket, 20) == -1)
        {
            LOG_ERROR << errno << ": Error binding the socket for " << conf::ctx.socket_path;
            return -1;
        }
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
     * Make a connection and session to the given host.
     * This only gets called whithin the comm handler thread.
     * @param ip_port Ip and port of the host.
     * @return 0 on success -1 on error.
    */
    int connect(const conf::host_ip_port &ip_port)
    {
        const int data_socket = accept(ctx.connection_socket, NULL, NULL);
        if (data_socket == -1)
        {
            LOG_ERROR << errno << ": Error accepting the new connection.";
            return -1;
        }
        ctx.session.emplace(data_socket);
        ctx.session->init();
        return 0;
    }

    /**
     * Disconnect the session.
     * This only gets called whithin the comm handler thread.
    */
    void disconnect()
    {
        if (ctx.session.has_value())
        {
            ctx.session->close_session();
            ctx.session.reset();
        }
    }

    void comm_handler_loop()
    {
        LOG_INFO << "Message processor started.";

        util::mask_signal();
        struct pollfd pfd;

        while (!ctx.is_shutting_down)
        {
            // Process queued messaged only if there's a session.
            if (ctx.session.has_value())
            {
                // If no messages were processed in this cycle, wait for some time.
                if (ctx.session->process_inbound_msg_queue() <= 0)
                    util::sleep(10);

                // If session is marked for closure since there's an issue, We disconnect the current session.
                // And try to create a new session in the next round
                if (ctx.session->state == SESSION_STATE::MUST_CLOSE)
                {
                    LOG_DEBUG << "Closing the session due to a failure.";
                    disconnect();
                    util::sleep(1000);
                }
            }
            else
            {
                pfd.fd = ctx.connection_socket;
                pfd.events = POLLIN;

                // Wait for some time if no connections are available.
                if (poll(&pfd, 1, POLL_TIMEOUT) > 0)
                    connect(conf::cfg.server.ip_port);
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
} // namespace comm
