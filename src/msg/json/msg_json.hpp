#ifndef _HP_MSG_MSG_JSON_
#define _HP_MSG_MSG_JSON_

#include "../../pchheader.hpp"
#include "../msg_common.hpp"

/**
 * Parser helpers for json messages.
 */
namespace msg::json
{
    int parse_message(jsoncons::json &d, std::string_view message);

    int extract_type(std::string &extracted_type, const jsoncons::json &d);

    int extract_commons(std::string &type, std::string &id, std::string &pubkey, const jsoncons::json &d);

    int extract_create_message(create_msg &msg, const jsoncons::json &d);
    
    int extract_destroy_message(destroy_msg &msg, const jsoncons::json &d);

    int extract_start_message(start_msg &msg, const jsoncons::json &d);

    int extract_stop_message(stop_msg &msg, const jsoncons::json &d);

    void create_response(std::string &msg, std::string_view response_type, std::string_view content);

} // namespace msg::json

#endif