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

    // Stores port pair assigned to a container.
    struct ports
    {
        uint16_t peer_port = 0;
        uint16_t user_port = 0;

        bool operator==(const ports &other) const
        {
            return peer_port == other.peer_port && user_port == other.user_port;
        }
    };

    struct instance_info
    {
        std::string owner_pubkey;
        std::string name;
        std::string ip;
        std::string pubkey;
        std::string contract_id;
        ports assigned_ports;
        std::string status;
    };

    struct resources
    {
        size_t cpu_micro_seconds = 0; // CPU time an instance can consume.
        size_t mem_bytes = 0;         // Memory an instance can allocate.
        size_t storage_bytes = 0;     // Physical storage an instance can allocate.
    };

    int init();
    void deinit();
    int create_new_instance(instance_info &info, std::string_view owner_pubkey);
    int run_container(const std::string &folder_name, const ports &assigned_ports);
    int start_container(const std::string &container_name);
    int stop_container(const std::string &container_name);
    int destroy_container(const std::string &container_name);
    void kill_all_containers();
    int create_contract(instance_info &info, const std::string &folder_name, const ports &assigned_ports);
    int write_json_file(const int fd, const jsoncons::ojson &d);
    int get_resources(resources &resources);
} // namespace hp
#endif