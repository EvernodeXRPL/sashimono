#ifndef _SA_COMM_COMM_SERVER_
#define _SA_COMM_COMM_SERVER_

#include "../pchheader.hpp"
#include "../conf.hpp"

namespace comm
{
    int init();

    void deinit();

    int connect(const conf::host_ip_port &ip_port);

    void disconnect();

    void wait();
    
} // namespace comm

#endif
