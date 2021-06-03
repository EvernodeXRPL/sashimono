#ifndef _HP_COMM_COMM_SESSION_
#define _HP_COMM_COMM_SESSION_

#include "../pchheader.hpp"
#include "../conf.hpp"
#include "hpws.hpp"

namespace comm
{
    enum SESSION_STATE
    {
        NONE,       // Session is not yet initialized properly.
        ACTIVE,     // Session is active and functioning.
        MUST_CLOSE, // Session socket is in unusable state and must be closed.
        CLOSED      // Session is fully closed.
    };

    /** 
     * Represents an active WebSocket connection
     */
    class comm_session
    {
    private:
        SESSION_STATE state = SESSION_STATE::NONE;
        std::optional<hpws::client> hpws_client;
        const std::string uniqueid;     // IP address.
        const std::string host_address; // Connection host address of the remote party.
        std::thread reader_thread;      // The thread responsible for reading messages from the read fd.

        void reader_loop();

    public:
        comm_session(
            std::string_view host_address, hpws::client &&hpws_client);
        int init();
        void close();
        void wait();
    };

} // namespace comm

#endif
