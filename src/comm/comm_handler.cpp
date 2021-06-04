#include "comm_handler.hpp"
#include "../util/util.hpp"
#include "../conf.hpp"
#include "hpws.hpp"

namespace comm
{
    constexpr uint32_t DEFAULT_MAX_MSG_SIZE = 1 * 1024 * 1024; // 1MB;
    bool init_success;

    comm_ctx ctx;

    int init()
    {
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
        std::string_view host = ip_port.host_address;
        const uint16_t port = ip_port.port;

        LOG_DEBUG << "Trying to connect " << host << ":" << std::to_string(port);

        std::variant<hpws::client, hpws::error> client_result = hpws::client::connect(conf::ctx.hpws_exe_path, DEFAULT_MAX_MSG_SIZE, host, port, "/", {}, util::fork_detach);

        if (std::holds_alternative<hpws::error>(client_result))
        {
            const hpws::error error = std::get<hpws::error>(client_result);
            if (error.first != 202)
                LOG_ERROR << "Connection hpws error:" << error.first << " " << error.second;
            return -1;
        }
        else
        {
            hpws::client client = std::move(std::get<hpws::client>(client_result));
            const std::variant<std::string, hpws::error> host_result = client.host_address();
            if (std::holds_alternative<hpws::error>(host_result))
            {
                const hpws::error error = std::get<hpws::error>(host_result);
                LOG_ERROR << "Error getting ip from hpws:" << error.first << " " << error.second;
                return -1;
            }
            else
            {
                const std::string &host_address = std::get<std::string>(host_result);
                ctx.session.emplace(host_address, std::move(client));
                ctx.session->init();
            }
        }
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
            ctx.session->close();
            ctx.session.reset();
        }
    }

    void comm_handler_loop()
    {
        LOG_INFO << "Message processor started.";

        util::mask_signal();

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
                    LOG_DEBUG << "Closing the session due to a failure: " << ctx.session->display_name();
                    disconnect();
                    util::sleep(1000);
                }
            }
            else
            {
                // If host connection failed wait for some time.
                if (connect(conf::cfg.server.ip_port) == -1)
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
