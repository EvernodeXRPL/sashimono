#ifndef _SA_COMM_COMM_SERVER_
#define _SA_COMM_COMM_SERVER_

#include "../pchheader.hpp"
#include "comm_session.hpp"

namespace comm
{
    struct comm_ctx
    {
        std::optional<comm_session> session;
        bool is_shutting_down = false;
        std::thread comm_handler_thread; // Incoming message processor thread.
    };

    extern comm_ctx ctx;

    int init();

    void deinit();

    int connect(const conf::host_ip_port &ip_port);

    void disconnect();

    void comm_handler_loop();

    void wait();

} // namespace comm

#endif
