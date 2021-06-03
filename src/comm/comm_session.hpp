#ifndef _HP_COMM_COMM_SESSION_
#define _HP_COMM_COMM_SESSION_

#include "../pchheader.hpp"
#include "../conf.hpp"
#include "hpws.hpp"
#include "../msg/msg_parser.hpp"

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
        msg::msg_parser msg_parser;     // Message parser.
        const std::string uniqueid;     // IP address.
        const std::string host_address; // Connection host address of the remote party.

        std::thread reader_thread;                               // The thread responsible for reading messages from the read fd.
        std::thread writer_thread;                               // The thread responsible for writing messages to the write fd.
        moodycamel::ReaderWriterQueue<std::string> in_msg_queue; // Holds incoming messages waiting to be processed.
        moodycamel::ConcurrentQueue<std::string> out_msg_queue;  // Holds outgoing messages waiting to be processed.

        void reader_loop();
        int handle_message(std::string_view msg);
        int process_outbound_message(std::string_view message);
        void process_outbound_msg_queue();

    public:
        comm_session(
            std::string_view host_address, hpws::client &&hpws_client);
        int init();
        int send(std::string_view message);
        int process_next_inbound_message();
        void close();
    };

} // namespace comm

#endif
