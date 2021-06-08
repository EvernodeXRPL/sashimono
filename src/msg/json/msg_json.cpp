#include "msg_json.hpp"

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
     * Extracts the message 'type' value from the json document.
     */
    int extract_type(std::string &extracted_type, const jsoncons::json &d)
    {
        extracted_type = d[msg::FLD_TYPE].as<std::string>();
        return 0;
    }

    /**
     * Extracts type, id and pubkey in the msg.
     * @param type Type in the message.
     * @param id id in the message.
     * @param pubkey Pubkey in the message.
     * @param d The json document holding the read request message.
     *          Accepted signed input container format:
     *          {
     *            ...
     *            "type": "<message type>",
     *            "id": "<message id>",
     *            "owner_pubkey": "<pubkey of the owner>",
     *            ...
     *          }
     * @return 0 on successful extraction. -1 for failure.
     */
    int extract_commons(std::string &type, std::string &id, std::string &pubkey, const jsoncons::json &d)
    {
        if (extract_type(type, d) == -1)
            return -1;

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

        if (!d.contains(msg::FLD_PUBKEY))
        {
            LOG_ERROR << "Field owner_pubkey is missing.";
            return -1;
        }

        if (!d[msg::FLD_PUBKEY].is<std::string>())
        {
            LOG_ERROR << "Invalid owner_pubkey value.";
            return -1;
        }

        id = d[msg::FLD_ID].as<std::string>();
        pubkey = d[msg::FLD_PUBKEY].as<std::string>();
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
     *          }
     * @return 0 on successful extraction. -1 for failure.
     */
    int extract_create_message(create_msg &msg, const jsoncons::json &d)
    {
        if (extract_commons(msg.type, msg.id, msg.pubkey, d) == -1)
            return -1;
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
        if (extract_commons(msg.type, msg.id, msg.pubkey, d) == -1)
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
        if (extract_commons(msg.type, msg.id, msg.pubkey, d) == -1)
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
        if (extract_commons(msg.type, msg.id, msg.pubkey, d) == -1)
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
     */
    void build_response(std::string &msg, std::string_view response_type, std::string_view reply_for, std::string_view content)
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
        msg += SEP_COLON;
        msg += content;
        msg += "\"}";
    }

    /**
     * Constructs a json response for create message.
     * @param msg Buffer to construct the generated json message string into.
     *            Message format:
     *            {
     *              'reply_for': '<reply_for>'
     *              'type': '<message type>',
     *              "name": "<container name>"
     *              "ip": "<ip of the container>"
     *              "pubkey": "<public key of the contract>"
     *              "contract_id": "<contract id of the contract>"
     *              "peer_port": "<peer port of the container>"
     *              "user_port": "<user port of the container>"
     *            }
     * @param response_type Type of the response.
     * @param content Content inside the response.
     */
    void build_create_response(std::string &msg, const hp::instance_info &info, std::string_view reply_for)
    {
        msg.reserve(1024);
        msg += "{\"";
        msg += msg::FLD_REPLY_FOR;
        msg += SEP_COLON;
        msg += std::string(reply_for);
        msg += SEP_COMMA;
        msg += msg::FLD_TYPE;
        msg += SEP_COLON;
        msg += msg::MSGTYPE_CREATE_RES;
        msg += SEP_COMMA;
        msg += "name";
        msg += SEP_COLON;
        msg += info.name;
        msg += SEP_COMMA;
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