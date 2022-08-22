#ifndef _HP_MSG_MSG_COMMON_
#define _HP_MSG_MSG_COMMON_

#include "../pchheader.hpp"
#include "../conf.hpp"

namespace msg
{
    struct create_msg
    {
        std::string type;
        std::string container_name;
        std::string pubkey;
        std::string contract_id;
        std::string image;
    };

    struct history_configuration
    {
        std::optional<uint64_t> max_primary_shards;
        std::optional<uint64_t> max_raw_shards;
    };

    struct node_config
    {
        std::string role;
        std::string history;
        history_configuration history_config;
    };

    struct c_log_config
    {
        std::optional<bool> enable;
        std::optional<size_t> max_mbytes_per_file;
        std::optional<size_t> max_file_count;
    };

    struct consensus_config
    {
        std::optional<std::string> mode;
        std::optional<uint32_t> roundtime;
        std::optional<uint32_t> stage_slice;
        std::optional<uint16_t> threshold;
    };

    struct npl_config
    {
        std::optional<std::string> mode;
    };

    struct round_limits_config
    {
        std::optional<size_t> user_input_bytes;
        std::optional<size_t> user_output_bytes;
        std::optional<size_t> npl_output_bytes;
        std::optional<size_t> proc_cpu_seconds;
        std::optional<size_t> proc_mem_bytes;
        std::optional<size_t> proc_ofd_count;
    };

    struct contract_config
    {
        std::optional<uint32_t> roundtime;
        std::set<std::string> unl;
        std::optional<bool> execute;
        std::optional<std::string> environment;
        std::optional<uint16_t> max_input_ledger_offset;
        c_log_config log;
        consensus_config consensus;
        npl_config npl;
        round_limits_config round_limits;
    };

    struct peer_discovery_config
    {
        std::optional<bool> enabled;      // Whether dynamic peer discovery is on/off.
        std::optional<uint16_t> interval; // Time interval in ms to find for known_peers dynamicpeerdiscovery should be on for this
    };
    struct mesh_config
    {
        std::optional<uint32_t> idle_timeout; // Idle connection timeout ms for peer connections.
        std::set<conf::host_ip_port> known_peers;
        std::optional<bool> msg_forwarding;                  // Whether peer message forwarding is on/off.
        std::optional<uint16_t> max_connections;             // Max peer connections.
        std::optional<uint16_t> max_known_connections;       // Max known peer connections.
        std::optional<uint16_t> max_in_connections_per_host; // Max inbound peer connections per remote host (IP).
        std::optional<uint64_t> max_bytes_per_msg;           // Peer message max size in bytes.
        std::optional<uint64_t> max_bytes_per_min;           // Peer message rate (characters(bytes) per minute).
        std::optional<uint64_t> max_bad_msgs_per_min;        // Peer bad messages per minute.
        std::optional<uint64_t> max_bad_msgsigs_per_min;     // Peer bad signatures per minute.
        std::optional<uint64_t> max_dup_msgs_per_min;        // Peer max duplicate messages per minute.
        peer_discovery_config peer_discovery;                // Peer discovery configs.
    };

    struct user_config
    {
        std::optional<uint32_t> idle_timeout;                // Idle connection timeout ms for user connections.
        std::optional<uint64_t> max_bytes_per_msg;           // User message max size in bytes
        std::optional<uint64_t> max_bytes_per_min;           // User message rate (characters(bytes) per minute)
        std::optional<uint64_t> max_bad_msgs_per_min;        // User bad messages per minute
        std::optional<uint16_t> max_connections;             // Max inbound user connections
        std::optional<uint16_t> max_in_connections_per_host; // Max inbound user connections per remote host (IP).
        std::optional<uint64_t> concurrent_read_requests;    // Supported concurrent read requests count.
    };

    struct hpfs_log_config
    {
        std::string log_level; // Log severity level (dbg, inf, wrn, wrr)
    };

    struct hpfs_config
    {
        hpfs_log_config log;
    };

    struct log_config
    {
        std::string log_level;                     // Log severity level (dbg, inf, wrn, wrr)
        std::unordered_set<std::string> loggers;   // List of enabled loggers (console, file)
        std::optional<size_t> max_mbytes_per_file; // Max MB size of a single log file.
        std::optional<size_t> max_file_count;      // Max no. of log files to keep.
    };

    // Keep numerical config valus as optional so when updating the config if the value is empty
    // We do nothing otherwise we take the value and update the config.
    struct config_struct
    {
        node_config node;
        contract_config contract;
        mesh_config mesh;
        user_config user;
        hpfs_config hpfs;
        log_config log;
    };

    struct initiate_msg
    {
        std::string type;
        std::string container_name;
        config_struct config;
    };

    struct destroy_msg
    {
        std::string type;
        std::string container_name;
    };

    struct start_msg
    {
        std::string type;
        std::string container_name;
    };

    struct stop_msg
    {
        std::string type;
        std::string container_name;
    };

    struct inspect_msg
    {
        std::string type;
        std::string container_name;
    };

    // Message field names
    constexpr const char *FLD_TYPE = "type";
    constexpr const char *FLD_CONTENT = "content";
    constexpr const char *FLD_PUBKEY = "owner_pubkey";
    constexpr const char *FLD_CONTAINER_NAME = "container_name";
    constexpr const char *FLD_CONTRACT_ID = "contract_id";
    constexpr const char *FLD_IMAGE = "image";
    constexpr const char *FLD_KNOWN_PEERS = "known_peers";
    constexpr const char *FLD_MESH = "mesh";
    constexpr const char *FLD_USER = "user";
    constexpr const char *FLD_EXECUTE = "execute";
    constexpr const char *FLD_ENVIRONMENT = "environment";
    constexpr const char *FLD_MAX_INP_LEDGER_OFFSET = "max_input_ledger_offset";
    constexpr const char *FLD_CONSENSUS = "consensus";
    constexpr const char *FLD_NPL = "npl";
    constexpr const char *FLD_MODE = "mode";
    constexpr const char *FLD_ROUNDTIME = "roundtime";
    constexpr const char *FLD_STAGE_SLICE = "stage_slice";
    constexpr const char *FLD_THRESHOLD = "threshold";
    constexpr const char *FLD_ROUND_LIMITS = "round_limits";
    constexpr const char *FLD_USER_INP_BYTES = "user_input_bytes";
    constexpr const char *FLD_USER_OUTP_BYTES = "user_output_bytes";
    constexpr const char *FLD_NPL_OUTP_BYTES = "npl_output_bytes";
    constexpr const char *FLD_PROC_CPU_SECS = "proc_cpu_seconds";
    constexpr const char *FLD_PROC_MEM_BYTES = "proc_mem_bytes";
    constexpr const char *FLD_PROC_OFD_COUNT = "proc_ofd_count";
    constexpr const char *FLD_LOG = "log";
    constexpr const char *FLD_LOG_LEVEL = "log_level";
    constexpr const char *FLD_ENABLE = "enable";
    constexpr const char *FLD_ENABLED = "enabled";
    constexpr const char *FLD_INTERVAL = "interval";
    constexpr const char *FLD_MAX_MB_PER_FILE = "max_mbytes_per_file";
    constexpr const char *FLD_MAX_FILE_COUNT = "max_file_count";
    constexpr const char *FLD_UNL = "unl";
    constexpr const char *FLD_CONTRACT = "contract";
    constexpr const char *FLD_NODE = "node";
    constexpr const char *FLD_HPFS = "hpfs";
    constexpr const char *FLD_CONFIG = "config";
    constexpr const char *FLD_ROLE = "role";
    constexpr const char *FLD_HISTORY = "history";
    constexpr const char *FLD_MAX_P_SHARDS = "max_primary_shards";
    constexpr const char *FLD_HISTORY_CONFIG = "history_config";
    constexpr const char *FLD_MAX_R_SHARDS = "max_raw_shards";
    constexpr const char *FLD_LOGGERS = "loggers";

    constexpr const char *FLD_IDLE_TIMEOUT = "idle_timeout";
    constexpr const char *FLD_MSG_FORWARDING = "msg_forwarding";
    constexpr const char *FLD_MAX_CONS = "max_connections";
    constexpr const char *FLD_MAX_KNOWN_CONS = "max_known_connections";
    constexpr const char *FLD_MAX_IN_CONS_HOST = "max_in_connections_per_host";
    constexpr const char *FLD_MAX_BYTES_MSG = "max_bytes_per_msg";
    constexpr const char *FLD_MAX_BYTES_MIN = "max_bytes_per_min";
    constexpr const char *FLD_MAX_BAD_MSG_MIN = "max_bad_msgs_per_min";
    constexpr const char *FLD_MAX_BAD_MSG_SIG_MIN = "max_bad_msgsigs_per_min";
    constexpr const char *FLD_MAX_DUP_MSG_MIN = "max_dup_msgs_per_min";
    constexpr const char *FLD_PEER_DISCOVERY = "peer_discovery";
    constexpr const char *FLD_CON_READ_REQ = "concurrent_read_requests";

    // Message types
    constexpr const char *MSGTYPE_INIT = "init";
    constexpr const char *MSGTYPE_CREATE = "create";
    constexpr const char *MSGTYPE_INITIATE = "initiate";
    constexpr const char *MSGTYPE_DESTROY = "destroy";
    constexpr const char *MSGTYPE_START = "start";
    constexpr const char *MSGTYPE_STOP = "stop";
    constexpr const char *MSGTYPE_LIST = "list";
    constexpr const char *MSGTYPE_INSPECT = "inspect";

    // Message res types
    constexpr const char *MSGTYPE_ERROR = "error";
    constexpr const char *MSGTYPE_CREATE_RES = "create_res";
    constexpr const char *MSGTYPE_CREATE_ERROR = "create_error";
    constexpr const char *MSGTYPE_INITIATE_RES = "initiate_res";
    constexpr const char *MSGTYPE_DESTROY_RES = "destroy_res";
    constexpr const char *MSGTYPE_START_RES = "start_res";
    constexpr const char *MSGTYPE_STOP_RES = "stop_res";
    constexpr const char *MSGTYPE_LIST_RES = "list_res";
    constexpr const char *MSGTYPE_INSPECT_RES = "inspect_res";
    constexpr const char *MSGTYPE_INSPECT_ERROR = "inspect_error";

} // namespace msg

#endif