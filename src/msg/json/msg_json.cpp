#include "msg_json.hpp"
#include "../../util/util.hpp"

namespace msg::json
{
    // JSON separators
    constexpr const char *SEP_COMMA = "\",\"";
    constexpr const char *SEP_COLON = "\":\"";
    constexpr const char *SEP_COMMA_NOQUOTE = ",\"";
    constexpr const char *SEP_COLON_NOQUOTE = "\":";
    constexpr const char *DOUBLE_QUOTE = "\"";
    constexpr uint16_t MOMENT_SIZE = 3600;       // Seconds per Moment.
    constexpr uint16_t INSTANCE_INFO_SIZE = 495; // Size of a single instance info
    /**
     * Parses a json message sent by the message board.
     * @param d Jsoncons document to which the parsed json should be loaded.
     * @param message The message to parse.
     *                Accepted message format:
     *                {
     *                  'type': '<message type>'
     *                  ...
     *                }
     * @return 0 on successful parsing. -1 for failure.
     */
    int parse_message(jsoncons::json &d, std::string_view message)
    {
        try
        {
            d = jsoncons::json::parse(message, jsoncons::strict_json_parsing());
        }
        catch (const std::exception &e)
        {
            LOG_ERROR << "JSON message parsing failed. " << e.what();
            return -1;
        }

        // Check existence of msg type field.
        if (!d.contains(msg::FLD_TYPE) || !d[msg::FLD_TYPE].is<std::string>())
        {
            LOG_ERROR << "JSON message 'type' missing or invalid.";
            return -1;
        }

        return 0;
    }

    /**
     * Extracts the message 'type' values from the json document.
     */
    int extract_type(std::string &extracted_type, const jsoncons::json &d)
    {
        if (!d.contains(msg::FLD_TYPE))
        {
            LOG_ERROR << "Field type is missing.";
            return -1;
        }

        if (!d[msg::FLD_TYPE].is<std::string>())
        {
            LOG_ERROR << "Invalid type value.";
            return -1;
        }
        extracted_type = d[msg::FLD_TYPE].as<std::string>();

        return 0;
    }

    /**
     * Extracts create message from msg.
     * @param msg Populated msg object.
     * @param d The json document holding the read request message.
     *          Accepted signed input container format:
     *          {
     *            "type": "create",
     *            "owner_pubkey": "<pubkey of the owner>"
     *            "contract_id": "<contract id>",
     *            "image": "<docker image key>"
     *          }
     * @return 0 on successful extraction. -1 for failure.
     */
    int extract_create_message(create_msg &msg, const jsoncons::json &d)
    {
        if (extract_type(msg.type, d) == -1)
            return -1;

        if (!d.contains(msg::FLD_CONTAINER_NAME))
        {
            LOG_ERROR << "Field container_name is missing.";
            return -1;
        }

        if (!d[msg::FLD_CONTAINER_NAME].is<std::string>())
        {
            LOG_ERROR << "Invalid container_name value.";
            return -1;
        }

        if (!d.contains(msg::FLD_PUBKEY))
        {
            LOG_ERROR << "Field owner_pubkey is missing.";
            return -1;
        }

        if (!d.contains(msg::FLD_CONTRACT_ID))
        {
            LOG_ERROR << "Field contract_id is missing.";
            return -1;
        }

        if (!d.contains(msg::FLD_IMAGE))
        {
            LOG_ERROR << "Field image is missing.";
            return -1;
        }

        if (!d[msg::FLD_PUBKEY].is<std::string>())
        {
            LOG_ERROR << "Invalid owner_pubkey value.";
            return -1;
        }

        if (!d[msg::FLD_CONTRACT_ID].is<std::string>())
        {
            LOG_ERROR << "Invalid contract_id value.";
            return -1;
        }

        if (!d[msg::FLD_IMAGE].is<std::string>())
        {
            LOG_ERROR << "Invalid image value.";
            return -1;
        }

        msg.container_name = d[msg::FLD_CONTAINER_NAME].as<std::string>();
        msg.pubkey = d[msg::FLD_PUBKEY].as<std::string>();
        msg.contract_id = d[msg::FLD_CONTRACT_ID].as<std::string>();
        msg.image = d[msg::FLD_IMAGE].as<std::string>();
        return 0;
    }

    /**
     * Extracts initiate message from msg.
     * @param msg Populated msg object.
     * @param d The json document holding the read request message.
     *          Accepted signed input container format:
     *          {
     *            "type": "initiate",
     *            "container_name": "<container name>",
     *            "config": {---config overrides----}
     *          }
     * @return 0 on successful extraction. -1 for failure.
     */
    int extract_initiate_message(initiate_msg &msg, const jsoncons::json &d)
    {
        // Commented out when merging create and initiate messages.
        // if (extract_type(msg.type, d) == -1)
        //     return -1;

        // if (!d.contains(msg::FLD_CONTAINER_NAME))
        // {
        //     LOG_ERROR << "Field container_name is missing.";
        //     return -1;
        // }

        // if (!d[msg::FLD_CONTAINER_NAME].is<std::string>())
        // {
        //     LOG_ERROR << "Invalid container_name value.";
        //     return -1;
        // }

        // msg.container_name = d[msg::FLD_CONTAINER_NAME].as<std::string>();
        if (!d.contains(msg::FLD_CONFIG))
        {
            LOG_ERROR << "Field config is missing.";
            return -1;
        }

        const jsoncons::json &config = d[msg::FLD_CONFIG];

        if (config.contains(msg::FLD_MESH))
        {
            const jsoncons::json &mesh = config[msg::FLD_MESH];
            if (mesh.contains(msg::FLD_IDLE_TIMEOUT))
                msg.config.mesh.idle_timeout = mesh[msg::FLD_IDLE_TIMEOUT].as<uint32_t>();

            if (mesh.contains(msg::FLD_KNOWN_PEERS))
            {
                if (!mesh[msg::FLD_KNOWN_PEERS].empty() && !mesh[msg::FLD_KNOWN_PEERS].is_array())
                {
                    LOG_ERROR << "Invalid known_peers value.";
                    return -1;
                }
                else if (!mesh[msg::FLD_KNOWN_PEERS].empty() && mesh[msg::FLD_KNOWN_PEERS].size() > 0)
                {
                    std::vector<std::string> splitted;
                    for (auto &val : mesh[msg::FLD_KNOWN_PEERS].array_range())
                    {
                        if (!val.is<std::string>())
                        {
                            LOG_ERROR << "Invalid peer value.";
                            return -1;
                        }

                        const std::string peer = val.as<std::string>();
                        util::split_string(splitted, peer, ":");
                        if (splitted.size() != 2)
                        {
                            LOG_ERROR << "Invalid peer value: " << peer;
                            return -1;
                        }

                        uint16_t port;
                        if (util::stoul(splitted.back(), port) == -1)
                        {
                            LOG_ERROR << "Invalid peer port value: " << peer;
                            return -1;
                        }

                        msg.config.mesh.known_peers.emplace(conf::host_ip_port{splitted.front(), port});
                        splitted.clear();
                    }
                }
            }

            if (mesh.contains(msg::FLD_MSG_FORWARDING))
                msg.config.mesh.msg_forwarding = mesh[msg::FLD_MSG_FORWARDING].as<bool>();

            if (mesh.contains(msg::FLD_MAX_CONS))
                msg.config.mesh.max_connections = mesh[msg::FLD_MAX_CONS].as<uint16_t>();

            if (mesh.contains(msg::FLD_MAX_KNOWN_CONS))
                msg.config.mesh.max_known_connections = mesh[msg::FLD_MAX_KNOWN_CONS].as<uint16_t>();

            if (mesh.contains(msg::FLD_MAX_IN_CONS_HOST))
                msg.config.mesh.max_in_connections_per_host = mesh[msg::FLD_MAX_IN_CONS_HOST].as<uint16_t>();

            if (mesh.contains(msg::FLD_MAX_BYTES_MSG))
                msg.config.mesh.max_bytes_per_msg = mesh[msg::FLD_MAX_BYTES_MSG].as<uint64_t>();

            if (mesh.contains(msg::FLD_MAX_BYTES_MIN))
                msg.config.mesh.max_bytes_per_min = mesh[msg::FLD_MAX_BYTES_MIN].as<uint64_t>();

            if (mesh.contains(msg::FLD_MAX_BAD_MSG_MIN))
                msg.config.mesh.max_bad_msgs_per_min = mesh[msg::FLD_MAX_BAD_MSG_MIN].as<uint64_t>();

            if (mesh.contains(msg::FLD_MAX_BAD_MSG_SIG_MIN))
                msg.config.mesh.max_bad_msgsigs_per_min = mesh[msg::FLD_MAX_BAD_MSG_SIG_MIN].as<uint64_t>();

            if (mesh.contains(msg::FLD_MAX_DUP_MSG_MIN))
                msg.config.mesh.max_dup_msgs_per_min = mesh[msg::FLD_MAX_DUP_MSG_MIN].as<uint64_t>();

            if (mesh.contains(msg::FLD_PEER_DISCOVERY))
            {
                const jsoncons::json &peer_discovery = mesh[msg::FLD_PEER_DISCOVERY];

                if (peer_discovery.contains(msg::FLD_ENABLED))
                    msg.config.mesh.peer_discovery.enabled = peer_discovery[msg::FLD_ENABLED].as<bool>();

                if (peer_discovery.contains(msg::FLD_INTERVAL))
                    msg.config.mesh.peer_discovery.interval = peer_discovery[msg::FLD_INTERVAL].as<uint16_t>();
            }
        }

        if (config.contains(msg::FLD_CONTRACT))
        {
            const jsoncons::json &contract = config[msg::FLD_CONTRACT];
            if (contract.contains(msg::FLD_UNL))
            {
                if (!contract[msg::FLD_UNL].empty() && !contract[msg::FLD_UNL].is_array())
                {
                    LOG_ERROR << "Invalid unl value.";
                    return -1;
                }
                else if (!contract[msg::FLD_UNL].empty() && contract[msg::FLD_UNL].size() > 0)
                {
                    for (auto &val : contract[msg::FLD_UNL].array_range())
                    {
                        if (!val.is<std::string>())
                        {
                            LOG_ERROR << "Invalid unl pubkey value.";
                            return -1;
                        }

                        const std::string unl_pubkey = val.as<std::string>();
                        const std::string unl_pubkey_bin = util::to_bin(unl_pubkey);
                        if (unl_pubkey_bin.empty())
                        {
                            LOG_ERROR << "Invalid unl pubkey value: " << unl_pubkey;
                            return -1;
                        }

                        msg.config.contract.unl.emplace(unl_pubkey_bin);
                    }
                }
            }
            if (contract.contains(msg::FLD_EXECUTE))
                msg.config.contract.execute = contract[msg::FLD_EXECUTE].as<bool>();

            if (contract.contains(msg::FLD_ENVIRONMENT))
                msg.config.contract.environment = contract[msg::FLD_ENVIRONMENT].as<std::string>();

            if (contract.contains(msg::FLD_MAX_INP_LEDGER_OFFSET))
                msg.config.contract.max_input_ledger_offset = contract[msg::FLD_MAX_INP_LEDGER_OFFSET].as<uint16_t>();

            if (contract.contains(msg::FLD_ROUNDTIME))
                msg.config.contract.roundtime = contract[msg::FLD_ROUNDTIME].as<uint32_t>();

            if (contract.contains(msg::FLD_CONSENSUS))
            {
                const jsoncons::json &consensus = contract[msg::FLD_CONSENSUS];
                if (consensus.contains(msg::FLD_MODE))
                    msg.config.contract.consensus.mode = consensus[msg::FLD_MODE].as<std::string>();

                if (consensus.contains(msg::FLD_ROUNDTIME))
                    msg.config.contract.consensus.roundtime = consensus[msg::FLD_ROUNDTIME].as<uint32_t>();

                if (consensus.contains(msg::FLD_STAGE_SLICE))
                    msg.config.contract.consensus.stage_slice = consensus[msg::FLD_STAGE_SLICE].as<uint32_t>();

                if (consensus.contains(msg::FLD_THRESHOLD))
                    msg.config.contract.consensus.threshold = consensus[msg::FLD_THRESHOLD].as<uint16_t>();
            }

            if (contract.contains(msg::FLD_NPL))
            {
                const jsoncons::json &npl = contract[msg::FLD_NPL];
                if (npl.contains(msg::FLD_MODE))
                    msg.config.contract.npl.mode = npl[msg::FLD_MODE].as<std::string>();
            }

            if (contract.contains(msg::FLD_ROUND_LIMITS))
            {
                const jsoncons::json &round_limits = contract[msg::FLD_ROUND_LIMITS];
                if (round_limits.contains(msg::FLD_USER_INP_BYTES))
                    msg.config.contract.round_limits.user_input_bytes = round_limits[msg::FLD_USER_INP_BYTES].as<uint64_t>();

                if (round_limits.contains(msg::FLD_USER_OUTP_BYTES))
                    msg.config.contract.round_limits.user_output_bytes = round_limits[msg::FLD_USER_OUTP_BYTES].as<uint64_t>();

                if (round_limits.contains(msg::FLD_NPL_OUTP_BYTES))
                    msg.config.contract.round_limits.npl_output_bytes = round_limits[msg::FLD_NPL_OUTP_BYTES].as<uint64_t>();

                if (round_limits.contains(msg::FLD_PROC_CPU_SECS))
                    msg.config.contract.round_limits.proc_cpu_seconds = round_limits[msg::FLD_PROC_CPU_SECS].as<uint64_t>();

                if (round_limits.contains(msg::FLD_PROC_MEM_BYTES))
                    msg.config.contract.round_limits.proc_mem_bytes = round_limits[msg::FLD_PROC_MEM_BYTES].as<uint64_t>();

                if (round_limits.contains(msg::FLD_PROC_OFD_COUNT))
                    msg.config.contract.round_limits.proc_ofd_count = round_limits[msg::FLD_PROC_OFD_COUNT].as<uint64_t>();
            }

            if (contract.contains(msg::FLD_LOG))
            {
                const jsoncons::json &log = contract[msg::FLD_LOG];
                if (log.contains(msg::FLD_ENABLE))
                    msg.config.contract.log.enable = log[msg::FLD_ENABLE].as<bool>();

                if (log.contains(msg::FLD_MAX_MB_PER_FILE))
                    msg.config.contract.log.max_mbytes_per_file = log[msg::FLD_MAX_MB_PER_FILE].as<size_t>();

                if (log.contains(msg::FLD_MAX_FILE_COUNT))
                    msg.config.contract.log.max_file_count = log[msg::FLD_MAX_FILE_COUNT].as<size_t>();
            }
        }

        if (config.contains(msg::FLD_NODE))
        {
            const jsoncons::json &node = config[msg::FLD_NODE];
            if (node.contains(msg::FLD_ROLE))
            {
                if (!node[msg::FLD_ROLE].is<std::string>())
                {
                    LOG_ERROR << "Invalid role value.";
                    return -1;
                }

                msg.config.node.role = node[msg::FLD_ROLE].as<std::string>();
            }

            if (node.contains(msg::FLD_HISTORY))
            {
                if (!node[msg::FLD_HISTORY].is<std::string>())
                {
                    LOG_ERROR << "Invalid history value.";
                    return -1;
                }

                msg.config.node.history = node[msg::FLD_HISTORY].as<std::string>();
            }
            if (node.contains(msg::FLD_HISTORY_CONFIG))
            {
                const jsoncons::json &history_config = node[msg::FLD_HISTORY_CONFIG];
                if (history_config.contains(msg::FLD_MAX_P_SHARDS))
                {
                    if (!history_config[msg::FLD_MAX_P_SHARDS].empty() && !history_config[msg::FLD_MAX_P_SHARDS].is<uint64_t>())
                    {
                        LOG_ERROR << "Invalid max_primary_shards value.";
                        return -1;
                    }
                    else if (!history_config[msg::FLD_MAX_P_SHARDS].empty())
                        msg.config.node.history_config.max_primary_shards = history_config[msg::FLD_MAX_P_SHARDS].as<uint64_t>();
                }

                if (history_config.contains(msg::FLD_MAX_R_SHARDS))
                {
                    if (!history_config[msg::FLD_MAX_R_SHARDS].empty() && !history_config[msg::FLD_MAX_R_SHARDS].is<uint64_t>())
                    {
                        LOG_ERROR << "Invalid max_raw_shards value.";
                        return -1;
                    }
                    else if (!history_config[msg::FLD_MAX_R_SHARDS].empty())
                        msg.config.node.history_config.max_raw_shards = history_config[msg::FLD_MAX_R_SHARDS].as<uint64_t>();
                }
            }
        }

        if (config.contains(msg::FLD_USER))
        {
            const jsoncons::json &user = config[msg::FLD_USER];
            if (user.contains(msg::FLD_IDLE_TIMEOUT))
                msg.config.user.idle_timeout = user[msg::FLD_IDLE_TIMEOUT].as<uint32_t>();

            if (user.contains(msg::FLD_MAX_BYTES_MSG))
                msg.config.user.max_bytes_per_msg = user[msg::FLD_MAX_BYTES_MSG].as<uint64_t>();

            if (user.contains(msg::FLD_MAX_BYTES_MIN))
                msg.config.user.max_bytes_per_min = user[msg::FLD_MAX_BYTES_MIN].as<uint64_t>();

            if (user.contains(msg::FLD_MAX_BAD_MSG_MIN))
                msg.config.user.max_bad_msgs_per_min = user[msg::FLD_MAX_BAD_MSG_MIN].as<uint64_t>();

            if (user.contains(msg::FLD_MAX_CONS))
                msg.config.user.max_connections = user[msg::FLD_MAX_CONS].as<uint16_t>();

            if (user.contains(msg::FLD_MAX_IN_CONS_HOST))
                msg.config.user.max_in_connections_per_host = user[msg::FLD_MAX_IN_CONS_HOST].as<uint16_t>();

            if (user.contains(msg::FLD_CON_READ_REQ))
                msg.config.user.concurrent_read_requests = user[msg::FLD_CON_READ_REQ].as<uint64_t>();
        }
        if (config.contains(msg::FLD_HPFS))
        {
            const jsoncons::json &hpfs = config[msg::FLD_HPFS];
            if (hpfs.contains(msg::FLD_LOG) && hpfs[msg::FLD_LOG].contains(msg::FLD_LOG_LEVEL))
                msg.config.hpfs.log.log_level = hpfs[msg::FLD_LOG][msg::FLD_LOG_LEVEL].as<std::string>();
        }

        if (config.contains(msg::FLD_LOG))
        {
            const jsoncons::json &log = config[msg::FLD_LOG];
            if (log.contains(msg::FLD_LOG_LEVEL))
                msg.config.log.log_level = log[msg::FLD_LOG_LEVEL].as<std::string>();

            if (log.contains(msg::FLD_MAX_MB_PER_FILE))
                msg.config.log.max_mbytes_per_file = log[msg::FLD_MAX_MB_PER_FILE].as<uint64_t>();

            if (log.contains(msg::FLD_MAX_FILE_COUNT))
                msg.config.log.max_file_count = log[msg::FLD_MAX_FILE_COUNT].as<uint64_t>();

            if (log.contains(msg::FLD_LOGGERS))
            {
                if (!log[msg::FLD_LOGGERS].empty() && !log[msg::FLD_LOGGERS].is_array())
                {
                    LOG_ERROR << "Invalid loggers value.";
                    return -1;
                }
                else if (!log[msg::FLD_LOGGERS].empty() && log[msg::FLD_LOGGERS].size() > 0)
                {
                    for (auto &val : log[msg::FLD_LOGGERS].array_range())
                    {
                        if (!val.is<std::string>())
                        {
                            LOG_ERROR << "Invalid log value.";
                            return -1;
                        }
                        msg.config.log.loggers.emplace(val.as<std::string>());
                    }
                }
            }
        }
        return 0;
    }

    /**
     * Extracts destroy message from msg.
     * @param msg Populated msg object.
     * @param d The json document holding the read request message.
     *          Accepted signed input container format:
     *          {
     *            "type": "destroy",
     *            "owner_pubkey": "<pubkey of the owner>",
     *            "container_name": "<container_name>",
     *          }
     * @return 0 on successful extraction. -1 for failure.
     */
    int extract_destroy_message(destroy_msg &msg, const jsoncons::json &d)
    {
        if (extract_type(msg.type, d) == -1)
            return -1;

        if (!d.contains(msg::FLD_CONTAINER_NAME))
        {
            LOG_ERROR << "Field container_name is missing.";
            return -1;
        }

        if (!d[msg::FLD_CONTAINER_NAME].is<std::string>())
        {
            LOG_ERROR << "Invalid container_name value.";
            return -1;
        }

        msg.container_name = d[msg::FLD_CONTAINER_NAME].as<std::string>();
        return 0;
    }

    /**
     * Extracts start message from msg.
     * @param msg Populated msg object.
     * @param d The json document holding the read request message.
     *          Accepted signed input container format:
     *          {
     *            "type": "start",
     *            "owner_pubkey": "<pubkey of the owner>",
     *            "container_name": "<container_name>",
     *          }
     * @return 0 on successful extraction. -1 for failure.
     */
    int extract_start_message(start_msg &msg, const jsoncons::json &d)
    {
        if (extract_type(msg.type, d) == -1)
            return -1;

        if (!d.contains(msg::FLD_CONTAINER_NAME))
        {
            LOG_ERROR << "Field container_name is missing.";
            return -1;
        }

        if (!d[msg::FLD_CONTAINER_NAME].is<std::string>())
        {
            LOG_ERROR << "Invalid container_name value.";
            return -1;
        }

        msg.container_name = d[msg::FLD_CONTAINER_NAME].as<std::string>();
        return 0;
    }

    /**
     * Extracts stop message from msg.
     * @param msg Populated msg object.
     * @param d The json document holding the read request message.
     *          Accepted signed input container format:
     *          {
     *            "type": "stop",
     *            "owner_pubkey": "<pubkey of the owner>",
     *            "container_name": "<container_name>",
     *          }
     * @return 0 on successful extraction. -1 for failure.
     */
    int extract_stop_message(stop_msg &msg, const jsoncons::json &d)
    {
        if (extract_type(msg.type, d) == -1)
            return -1;

        if (!d.contains(msg::FLD_CONTAINER_NAME))
        {
            LOG_ERROR << "Field container_name is missing.";
            return -1;
        }

        if (!d[msg::FLD_CONTAINER_NAME].is<std::string>())
        {
            LOG_ERROR << "Invalid container_name value.";
            return -1;
        }

        msg.container_name = d[msg::FLD_CONTAINER_NAME].as<std::string>();
        return 0;
    }

    /**
     * Extracts inspect message from msg.
     * @param msg Populated msg object.
     * @param d The json document holding the message.
     *          Accepted signed input container format:
     *          {
     *            "type": "inspect",
     *            "container_name": "<container_name>",
     *          }
     * @return 0 on successful extraction. -1 for failure.
     */
    int extract_inspect_message(inspect_msg &msg, const jsoncons::json &d)
    {
        if (extract_type(msg.type, d) == -1)
            return -1;

        if (!d.contains(msg::FLD_CONTAINER_NAME))
        {
            LOG_ERROR << "Field container_name is missing.";
            return -1;
        }

        if (!d[msg::FLD_CONTAINER_NAME].is<std::string>())
        {
            LOG_ERROR << "Invalid container_name value.";
            return -1;
        }

        msg.container_name = d[msg::FLD_CONTAINER_NAME].as<std::string>();
        return 0;
    }

    /**
     * Constructs a generic json response.
     * @param msg Buffer to construct the generated json message string into.
     *            Message format:
     *            {
     *              'type': '<message type>',
     *              "content": "<any string>"
     *            }
     * @param response_type Type of the response.
     * @param content Content inside the response.
     * @param json_content Whether content is a json string.
     */
    void build_response(std::string &msg, std::string_view response_type, std::string_view content, const bool json_content)
    {
        // Extra 40 bytes added for the other data included, in addition to the content here
        msg.reserve(content.length() + 40);
        msg += "{\"";
        msg += msg::FLD_TYPE;
        msg += SEP_COLON;
        msg += response_type;
        msg += SEP_COMMA;
        msg += msg::FLD_CONTENT;
        msg += (json_content ? SEP_COLON_NOQUOTE : SEP_COLON);
        msg += content;
        msg += (json_content ? "}" : "\"}");
    }

    /**
     * Constructs a json response for create message.
     * @param msg Buffer to construct the generated json message string into.
     *            Message format:
     *            {
     *              "name": "<container name>"
     *              "username": "<instance user name>""
     *              "ip": "<ip of the container>"
     *              "pubkey": "<public key of the contract>"
     *              "contract_id": "<contract id of the contract>"
     *              "peer_port": "<peer port of the container>"
     *              "user_port": "<user port of the container>"
     *            }
     * @param response_type Type of the response.
     * @param content Content inside the response.
     */
    void build_create_response(std::string &msg, const hp::instance_info &info)
    {
        msg.reserve(1024);
        msg += "{\"";
        msg += "name";
        msg += SEP_COLON;
        msg += info.container_name;
        msg += SEP_COMMA;
        // msg += "username"; // Uncomment if username is required for debugging.
        // msg += SEP_COLON;
        // msg += info.username;
        // msg += SEP_COMMA;
        msg += "ip";
        msg += SEP_COLON;
        msg += info.ip;
        msg += SEP_COMMA;
        msg += "pubkey";
        msg += SEP_COLON;
        msg += info.pubkey;
        msg += SEP_COMMA;
        msg += "contract_id";
        msg += SEP_COLON;
        msg += info.contract_id;
        msg += SEP_COMMA;
        msg += "peer_port";
        msg += SEP_COLON;
        msg += std::to_string(info.assigned_ports.peer_port);
        msg += SEP_COMMA;
        msg += "user_port";
        msg += SEP_COLON;
        msg += std::to_string(info.assigned_ports.user_port);
        msg += "\"}";
    }

    /**
     * Constructs the response message for list message.
     * @param msg Buffer to construct the generated json message string into.
     *           Message format:
     *           [
     *             {
     *              "name": "<instance name>",
     *              "user": "<instance user name>",
     *              "image": "<docker image name>",
     *              "status": "<status of the instance>",
     *              "peer_port": "<peer port of the instance>",
     *              "user_port": "<user port of the instance>",
     *              "created_timestamp": <created on UNIX timestamp>,
     *              "contract_id": "<evernode contract id>",
     *              "expiry_approx_timestamp": <approx UNIX timestamp for expiration>,
     *              "created_ledger": <created on xrpl ledger>,
     *              "expiry_timestamp": <expires at the mentioned UNIX time>,
     *              "tenant": "<tenant xrp account address>",
     *             }
     *           ]
     * @param instances Instance list.
     *
     */
    void build_list_response(std::string &msg, const std::vector<hp::instance_info> &instances, const std::vector<hp::lease_info> &leases)
    {
        const uint32_t message_size = (INSTANCE_INFO_SIZE * instances.size()) + 3;
        msg.reserve(message_size);

        msg += "[";
        for (size_t i = 0; i < instances.size(); i++)
        {
            const hp::instance_info &instance = instances[i];

            msg += "{\"";
            msg += "name";
            msg += SEP_COLON;
            msg += instance.container_name;
            msg += SEP_COMMA;
            msg += "user";
            msg += SEP_COLON;
            msg += instance.username;
            msg += SEP_COMMA;
            msg += "image";
            msg += SEP_COLON;
            msg += instance.image_name;
            msg += SEP_COMMA;
            msg += "contract_id";
            msg += SEP_COLON;
            msg += instance.contract_id;
            msg += SEP_COMMA;
            msg += "status";
            msg += SEP_COLON;
            msg += instance.status;
            msg += SEP_COMMA;
            msg += "peer_port";
            msg += SEP_COLON_NOQUOTE;
            msg += std::to_string(instance.assigned_ports.peer_port);
            msg += SEP_COMMA_NOQUOTE;
            msg += "user_port";
            msg += SEP_COLON_NOQUOTE;
            msg += std::to_string(instance.assigned_ports.user_port);

            // Include matching lease information.
            const auto lease = std::find_if(leases.begin(), leases.end(), [&](const hp::lease_info &l)
                                            { return l.container_name == instance.container_name; });
            if (lease != leases.end())
            {
                msg += SEP_COMMA_NOQUOTE;
                msg += "created_timestamp";
                msg += SEP_COLON_NOQUOTE;
                msg += std::to_string(lease->timestamp);
                msg += SEP_COMMA_NOQUOTE;
                msg += "created_ledger";
                msg += SEP_COLON_NOQUOTE;
                msg += std::to_string(lease->created_on_ledger);
                msg += SEP_COMMA_NOQUOTE;
                msg += "expiry_timestamp";
                msg += SEP_COLON_NOQUOTE;
                msg += std::to_string(lease->timestamp + (lease->life_moments * MOMENT_SIZE));
                msg += SEP_COMMA_NOQUOTE;
                msg += "tenant";
                msg += SEP_COLON;
                msg += lease->tenant_xrp_address;
                msg += "\"";
            }

            msg += "}";
            if (i < instances.size() - 1)
                msg += ",";
        }
        msg += "]";

        std::cout << msg << "\n";
    }

    /**
     * Constructs the response message for inspect message.
     * @param msg Buffer to construct the generated json message string into.
     *           Message format:
     *             {
     *              "name": "<instance name>",
     *              "user": "<instance user name>",
     *              "image": "<docker image name>",
     *              "status": "<status of the instance>",
     *              "peer_port": "<peer port of the instance>",
     *              "user_port": "<user port of the instance>"
     *             }
     * @param instance Instance info.
     *
     */
    void build_inspect_response(std::string &msg, const hp::instance_info &instance)
    {
        msg.reserve(1024);
        msg += "{\"";
        msg += "name";
        msg += SEP_COLON;
        msg += instance.container_name;
        msg += SEP_COMMA;
        msg += "user";
        msg += SEP_COLON;
        msg += instance.username;
        msg += SEP_COMMA;
        msg += "image";
        msg += SEP_COLON;
        msg += instance.image_name;
        msg += SEP_COMMA;
        msg += "status";
        msg += SEP_COLON;
        msg += instance.status;
        msg += SEP_COMMA;
        msg += "peer_port";
        msg += SEP_COLON_NOQUOTE;
        msg += std::to_string(instance.assigned_ports.peer_port);
        msg += SEP_COMMA_NOQUOTE;
        msg += "user_port";
        msg += SEP_COLON_NOQUOTE;
        msg += std::to_string(instance.assigned_ports.user_port);
        msg += "}";
    }
} // namespace msg::json
