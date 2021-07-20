#ifndef _HP_MSG_MSG_COMMON_
#define _HP_MSG_MSG_COMMON_

#include "../pchheader.hpp"
#include "../conf.hpp"

namespace msg
{
    struct create_msg
    {
        std::string id;
        std::string type;
        std::string pubkey;
        std::string contract_id;
        std::string image;
    };

    // Keep numerical config valus as optional so when updating the config if the value is empty
    // We do nothing otherwise we take the value and update the config.
    struct initiate_msg
    {
        std::string id;
        std::string type;
        std::string container_name;
        std::set<conf::host_ip_port> peers;
        std::set<std::string> unl;
        std::string role;
        std::string history;
        std::optional<uint64_t> max_primary_shards;
        std::optional<uint64_t> max_raw_shards;
    };

    struct destroy_msg
    {
        std::string id;
        std::string type;
        std::string container_name;
    };

    struct start_msg
    {
        std::string id;
        std::string type;
        std::string container_name;
    };

    struct stop_msg
    {
        std::string id;
        std::string type;
        std::string container_name;
    };

    // Message field names
    constexpr const char *FLD_TYPE = "type";
    constexpr const char *FLD_REPLY_FOR = "reply_for";
    constexpr const char *FLD_CONTENT = "content";
    constexpr const char *FLD_PUBKEY = "owner_pubkey";
    constexpr const char *FLD_CONTAINER_NAME = "container_name";
    constexpr const char *FLD_CONTRACT_ID = "contract_id";
    constexpr const char *FLD_IMAGE = "image";
    constexpr const char *FLD_ID = "id";
    constexpr const char *FLD_PEERS = "peers";
    constexpr const char *FLD_UNL = "unl";
    constexpr const char *FLD_ROLE = "role";
    constexpr const char *FLD_HISTORY = "history";
    constexpr const char *FLD_MAX_P_SHARDS = "max_primary_shards";
    constexpr const char *FLD_MAX_R_SHARDS = "max_raw_shards";

    // Message types
    constexpr const char *MSGTYPE_INIT = "init";
    constexpr const char *MSGTYPE_CREATE = "create";
    constexpr const char *MSGTYPE_INITIATE = "initiate";
    constexpr const char *MSGTYPE_DESTROY = "destroy";
    constexpr const char *MSGTYPE_START = "start";
    constexpr const char *MSGTYPE_STOP = "stop";

    // Message res types
    constexpr const char *MSGTYPE_CREATE_RES = "create_res";
    constexpr const char *MSGTYPE_INITIATE_RES = "initiate_res";
    constexpr const char *MSGTYPE_DESTROY_RES = "destroy_res";
    constexpr const char *MSGTYPE_START_RES = "start_res";
    constexpr const char *MSGTYPE_STOP_RES = "stop_res";

} // namespace msg

#endif