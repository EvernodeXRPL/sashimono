#include "comm_handler.hpp"
#include "../util/util.hpp"
#include "hpws.hpp"
#include "comm_session.hpp"

namespace comm
{
    constexpr uint32_t DEFAULT_MAX_MSG_SIZE = 5 * 1024 * 1024;
    std::optional<comm_session> session;
    bool init_success;

    int init()
    {
        if (connect(conf::cfg.server.ip_port) == -1)
            return -1;
        
        init_success = true;

        return 0;
    }

    void deinit()
    {
        if (init_success)
            disconnect();
    }

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
                session.emplace(host_address, std::move(client));
                session->init();
            }
        }
        return 0;
    }

    void disconnect()
    {
        if (session.has_value())
        {
            session->close();
            session.reset();
        }
    }

    /**
     * Wait for the session.
     */
    void wait()
    {
        session->wait();
    }
} // namespace comm
