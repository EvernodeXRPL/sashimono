#ifndef _HP_MSG_MSG_JSON_
#define _HP_MSG_MSG_JSON_

#include "../../pchheader.hpp"
#include "../msg_common.hpp"
#include "../../hp_manager.hpp"

/**
 * Parser helpers for json messages.
 */
namespace msg::json
{
    int parse_message(jsoncons::json &d, std::string_view message);

    int extract_type_and_id(std::string &extracted_type, std::string &extracted_id, const jsoncons::json &d);

    int extract_commons(std::string &type, std::string &id, std::string &pubkey, const jsoncons::json &d);

    int extract_create_message(create_msg &msg, const jsoncons::json &d);

    int extract_initiate_message(initiate_msg &msg, const jsoncons::json &d);

    int extract_destroy_message(destroy_msg &msg, const jsoncons::json &d);

    int extract_start_message(start_msg &msg, const jsoncons::json &d);

    int extract_stop_message(stop_msg &msg, const jsoncons::json &d);

    void build_response(std::string &msg, std::string_view response_type, std::string_view reply_for, std::string_view content, const bool json_content = false);

    void build_create_response(std::string &msg, const hp::instance_info &info);

} // namespace msg::json

#endif