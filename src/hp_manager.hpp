#ifndef _SA_HP_MANAGER_
#define _SA_HP_MANAGER_

#include "pchheader.hpp"

namespace hp
{
    constexpr const char *CONTAINER_STATES[]{"RUNNING", "STOPPED", "DESTROYED"};
    enum STATES
    {
        RUNNING,
        STOPPED,
        DESTROYED
    };

    struct instance_info
    {
        std::string name;
        std::string ip;
        std::string pubkey;
        std::string contract_id;
        std::uint16_t peer_port;
        std::uint16_t user_port;
    };

    int init();
    void deinit();
    int create_new_instance(instance_info &info, std::string_view owner_pubkey);
    int run_container(const std::string &folder_name, const uint16_t user_port, const uint16_t peer_port);
    int start_container(const std::string &container_name);
    int stop_container(const std::string &container_name);
    int destroy_container(const std::string &container_name);
    void kill_all_containers();
    int create_contract(instance_info &info, const std::string &folder_name, const uint16_t peer_port, const uint16_t user_port);
    int write_json_file(const int fd, const jsoncons::ojson &d);
} // namespace hp
#endif