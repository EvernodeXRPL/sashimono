#ifndef _SA_HP_MANAGER_
#define _SA_HP_MANAGER_

#include "pchheader.hpp"
#include "hpfs_manager.hpp"

namespace hp
{
    constexpr const char *CONTAINER_STATES[]{"running", "stopped", "destroyed", "exited"};

    enum STATES
    {
        RUNNING,
        STOPPED,
        DESTROYED,
        EXITED
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
        std::string container_name;
        std::string contract_dir;
        std::string ip;
        std::string pubkey;
        std::string contract_id;
        ports assigned_ports;
        std::string status;
        std::string username;
    };

    struct resources
    {
        size_t cpu_micro_seconds = 0; // CPU time an instance can consume.
        size_t mem_bytes = 0;         // Memory an instance can allocate.
        size_t storage_bytes = 0;     // Physical storage an instance can allocate.
    };

    int init();
    void deinit();
    void hp_monitor_loop();
    int create_new_instance(instance_info &info, std::string_view owner_pubkey);
    int run_container(std::string_view username, std::string_view container_name, std::string_view contract_dir, const ports &assigned_ports, instance_info &info);
    int start_container(std::string_view container_name);
    int docker_start(std::string_view username, std::string_view container_name);
    int docker_stop(std::string_view username, std::string_view container_name);
    int stop_container(std::string_view container_name);
    int destroy_container(std::string_view container_name);
    void kill_all_containers();
    int create_contract(std::string_view username, std::string_view contract_dir, std::string_view owner_pubkey, const ports &assigned_ports, instance_info &info);
    int write_json_file(const int fd, const jsoncons::ojson &d);
    int check_instance_status(std::string_view username, std::string_view container_name, std::string &status);
    int read_contract_cfg_values(std::string_view contract_dir, std::string &log_level, bool &is_full_history);
    int execute_bash_file(std::string_view file_name, std::vector<std::string> &output_params, std::string_view input_param = {});
    int install_user(int &user_id, std::string &username);
    int uninstall_user(std::string_view username);
} // namespace hp
#endif