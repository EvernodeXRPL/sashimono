#ifndef _HP_MSG_MSG_COMMON_
#define _HP_MSG_MSG_COMMON_

#include "../pchheader.hpp"

namespace msg
{
    struct create_msg
    {
        std::string id;
        std::string type;
        std::string pubkey;
    };

    struct destroy_msg
    {
        std::string id;
        std::string type;
        std::string pubkey;
        std::string contract_id;
    };

    struct start_msg
    {
        std::string id;
        std::string type;
        std::string pubkey;
        std::string contract_id;
    };

    struct stop_msg
    {
        std::string id;
        std::string type;
        std::string pubkey;
        std::string contract_id;
    };

    // Message field names
    constexpr const char *FLD_TYPE = "type";
    constexpr const char *FLD_REPLY_FOR = "reply_for";
    constexpr const char *FLD_CONTENT = "content";
    constexpr const char *FLD_PUBKEY = "owner_pubkey";
    constexpr const char *FLD_CONTRACT_ID = "contract_id";
    constexpr const char *FLD_ID = "id";

    // Message types
    constexpr const char *MSGTYPE_INIT = "init";
    constexpr const char *MSGTYPE_CREATE = "create";
    constexpr const char *MSGTYPE_DESTROY = "destroy";
    constexpr const char *MSGTYPE_START = "start";
    constexpr const char *MSGTYPE_STOP = "stop";

    // Message res types
    constexpr const char *MSGTYPE_CREATE_RES = "create_res";
    constexpr const char *MSGTYPE_DESTROY_RES = "destroy_res";
    constexpr const char *MSGTYPE_START_RES = "start_res";
    constexpr const char *MSGTYPE_STOP_RES = "stop_res";

} // namespace msg

#endif