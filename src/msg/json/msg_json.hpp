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

    int extract_type(std::string &extracted_type, const jsoncons::json &d);

    int extract_create_message(create_msg &msg, const jsoncons::json &d);

    int extract_initiate_message(initiate_msg &msg, const jsoncons::json &d);

    int extract_destroy_message(destroy_msg &msg, const jsoncons::json &d);

    int extract_start_message(start_msg &msg, const jsoncons::json &d);

    int extract_stop_message(stop_msg &msg, const jsoncons::json &d);

    int extract_inspect_message(inspect_msg &msg, const jsoncons::json &d);

    void build_response(std::string &msg, std::string_view response_type, std::string_view content, const bool json_content = false);

    void build_create_response(std::string &msg, const hp::instance_info &info);

    void build_list_response(std::string &msg, const std::vector<hp::instance_info> &instances, const std::vector<hp::lease_info> &leases);

    void build_inspect_response(std::string &msg, const hp::instance_info &instance);

    void build_error_response(std::string &msg, std::string_view container_name, std::string_view error);

} // namespace msg::json

#endif