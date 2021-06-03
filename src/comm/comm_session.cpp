#include "../pchheader.hpp"
#include "../util/util.hpp"
#include "../conf.hpp"
#include "hpws.hpp"
#include "comm_session.hpp"

namespace comm
{

    comm_session::comm_session(
        std::string_view host_address, hpws::client &&hpws_client)
        : uniqueid(host_address),
          host_address(host_address),
          hpws_client(std::move(hpws_client))
    {
    }

    /**
     * Init() should be called to activate the session.
     * Because we are starting threads here, after init() is called, the session object must not be "std::moved".
     * @return returns 0 on successful init, otherwise -1;
     */
    int comm_session::init()
    {
        if (state == SESSION_STATE::NONE)
        {
            reader_thread = std::thread(&comm_session::reader_loop, this);
            state = SESSION_STATE::ACTIVE;
            LOG_DEBUG << "Session started: " << uniqueid;
        }

        return 0;
    }

    void comm_session::reader_loop()
    {
        util::mask_signal();

        while (state != SESSION_STATE::CLOSED && hpws_client)
        {
            const std::variant<std::string_view, hpws::error> read_result = hpws_client->read();
            if (std::holds_alternative<hpws::error>(read_result))
            {
                const hpws::error error = std::get<hpws::error>(read_result);
                if (error.first != 1) // 1 indicates channel has closed.
                    LOG_DEBUG << "hpws client read failed:" << error.first << " " << error.second;
            }
            else
            {
                // Enqueue the message for processing.
                std::string_view data = std::get<std::string_view>(read_result);

                LOG_INFO << "Received message : " << data;

                // Signal the hpws client that we are ready for next message.
                const std::optional<hpws::error> error = hpws_client->ack(data);
                if (error.has_value())
                    LOG_DEBUG << "hpws client ack failed:" << error->first << " " << error->second;
            }
        }
    }

    /**
     * Close the connection and wrap up any session processing threads.
     * This will be only called by the global comm_server thread.
     */
    void comm_session::close()
    {
        if (state == SESSION_STATE::CLOSED)
            return;

        state = SESSION_STATE::CLOSED;

        // Destruct the hpws client instance so it will close the sockets and related processes.
        hpws_client.reset();

        if (reader_thread.joinable())
            reader_thread.join();

        LOG_DEBUG << "Session closed: " << uniqueid;
    }

    /**
     * Joins the listner thread.
     */
    void comm_session::wait()
    {
        reader_thread.join();
    }

} // namespace comm