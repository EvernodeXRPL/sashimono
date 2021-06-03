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

        if (connect(conf::cfg.server.ip_port) == -1)
            return;

        while (!ctx.is_shutting_down)
        {
            // If no messages were processed in this cycle, wait for some time.
            if (ctx.session->process_next_inbound_message() <= 0)
                util::sleep(10);
        }

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
