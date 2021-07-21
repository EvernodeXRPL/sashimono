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
     * Extracts the message 'type' and 'id' values from the json document.
     */
    int extract_type_and_id(std::string &extracted_type, std::string &extracted_id, const jsoncons::json &d)
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

        if (!d.contains(msg::FLD_ID))
        {
            LOG_ERROR << "Field id is missing.";
            return -1;
        }

        if (!d[msg::FLD_ID].is<std::string>())
        {
            LOG_ERROR << "Invalid id value.";
            return -1;
        }
        extracted_id = d[msg::FLD_ID].as<std::string>();

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
        if (extract_type_and_id(msg.type, msg.id, d) == -1)
            return -1;

        
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
     *            "owner_pubkey": "<pubkey of the owner>",
     *            "container_name": "<container name>",
     *            "peers": [<'ip:port' peer list>],
     *            "unl": [<hex unl pubkey list>],
     *            "role": <role>,
     *            "history": <history mode>,
     *            "max_primary_shards": <number of max primary shards>,
     *            "max_raw_shards": <number of max raw shards>
     *          }
     * @return 0 on successful extraction. -1 for failure.
     */
    int extract_initiate_message(initiate_msg &msg, const jsoncons::json &d)
    {
        if (extract_type_and_id(msg.type, msg.id, d) == -1)
            return -1;

        if (!d.contains(msg::FLD_CONTAINER_NAME))
        {
            LOG_ERROR << "Field contract_name is missing.";
            return -1;
        }

        if (!d[msg::FLD_CONTAINER_NAME].is<std::string>())
        {
            LOG_ERROR << "Invalid container_name value.";
            return -1;
        }

        msg.container_name = d[msg::FLD_CONTAINER_NAME].as<std::string>();

        if (d.contains(msg::FLD_PEERS))
        {
            if (!d[msg::FLD_PEERS].empty() && !d[msg::FLD_PEERS].is_array())
            {
                LOG_ERROR << "Invalid peers value.";
                return -1;
            }
            else if (!d[msg::FLD_PEERS].empty() && d[msg::FLD_PEERS].size() > 0)
            {
                std::vector<std::string> splitted;
                for (auto &val : d[msg::FLD_PEERS].array_range())
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

                    msg.peers.emplace(conf::host_ip_port{splitted.front(), port});
                    splitted.clear();
                }
            }
        }

        if (d.contains(msg::FLD_UNL))
        {
            if (!d[msg::FLD_UNL].empty() && !d[msg::FLD_UNL].is_array())
            {
                LOG_ERROR << "Invalid unl value.";
                return -1;
            }
            else if (!d[msg::FLD_UNL].empty() && d[msg::FLD_UNL].size() > 0)
            {
                for (auto &val : d[msg::FLD_UNL].array_range())
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

                    msg.unl.emplace(unl_pubkey_bin);
                }
            }
        }

        if (d.contains(msg::FLD_ROLE))
        {
            if (!d[msg::FLD_ROLE].is<std::string>())
            {
                LOG_ERROR << "Invalid role value.";
                return -1;
            }

            msg.role = d[msg::FLD_ROLE].as<std::string>();
        }

        if (d.contains(msg::FLD_HISTORY))
        {
            if (!d[msg::FLD_HISTORY].is<std::string>())
            {
                LOG_ERROR << "Invalid history value.";
                return -1;
            }

            msg.history = d[msg::FLD_HISTORY].as<std::string>();
        }

        if (d.contains(msg::FLD_MAX_P_SHARDS))
        {
            if (!d[msg::FLD_MAX_P_SHARDS].empty() && !d[msg::FLD_MAX_P_SHARDS].is<uint64_t>())
            {
                LOG_ERROR << "Invalid max_primary_shards value.";
                return -1;
            }
            else if (!d[msg::FLD_MAX_P_SHARDS].empty())
                msg.max_primary_shards = d[msg::FLD_MAX_P_SHARDS].as<uint64_t>();
        }

        if (d.contains(msg::FLD_MAX_R_SHARDS))
        {
            if (!d[msg::FLD_MAX_R_SHARDS].empty() && !d[msg::FLD_MAX_R_SHARDS].is<uint64_t>())
            {
                LOG_ERROR << "Invalid max_raw_shards value.";
                return -1;
            }
            else if (!d[msg::FLD_MAX_R_SHARDS].empty())
                msg.max_raw_shards = d[msg::FLD_MAX_R_SHARDS].as<uint64_t>();
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
        if (extract_type_and_id(msg.type, msg.id, d) == -1)
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
        if (extract_type_and_id(msg.type, msg.id, d) == -1)
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
        if (extract_type_and_id(msg.type, msg.id, d) == -1)
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
     *              'reply_for': '<reply_for>'
     *              'type': '<message type>',
     *              "content": "<any string>"
     *            }
     * @param response_type Type of the response.
     * @param content Content inside the response.
     * @param json_content Whether content is a json string.
     */
    void build_response(std::string &msg, std::string_view response_type, std::string_view reply_for, std::string_view content, const bool json_content)
    {
        msg.reserve(1024);
        msg += "{\"";
        msg += msg::FLD_REPLY_FOR;
        msg += SEP_COLON;
        msg += std::string(reply_for);
        msg += SEP_COMMA;
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

} // namespace msg::json