#ifndef _SA_COMM_COMM_SERVER_
#define _SA_COMM_COMM_SERVER_

#include "../pchheader.hpp"
#include "../msg/msg_parser.hpp"

namespace comm
{
    struct comm_ctx
    {
        bool is_shutting_down = false;
        std::thread comm_handler_thread; // Incoming message processor thread.
        int connection_socket = -1;
        int data_socket = -1;
    };

    extern comm_ctx ctx;

    int init();

    void deinit();

    int connect();

    void disconnect();

    void comm_handler_loop();

    int handle_message(const int message_size);

    int send(std::string_view message);

    void wait();

    int read_socket();

} // namespace comm

#endif
