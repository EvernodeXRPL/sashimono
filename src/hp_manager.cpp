#include "hp_manager.hpp"
#include "conf.hpp"
#include "crypto.hpp"
#include "util/util.hpp"
#include "sqlite.hpp"

namespace hp
{
    // Keep track of the ports of the most recent hp instance.
    ports last_assigned_ports;

    // This is defaults to true because it initialize last assigned ports when a new instance is created if there is no vacant ports available.
    bool last_port_assign_from_vacant = true;

    constexpr int FILE_PERMS = 0644;

    sqlite3 *db = NULL; // Database connection for hp related sqlite stuff.

    // Vector keeping vacant ports from destroyed instances.
    std::vector<ports> vacant_ports;

    /**
     * Initialize hp related environment.
    */
    int init()
    {
        const std::string db_path = conf::ctx.data_dir + "/hp_instances.sqlite";
        if (sqlite::open_db(db_path, &db, true) == -1 ||
            sqlite::initialize_hp_db(db) == -1)
        {
            LOG_ERROR << "Error preparing hp database in " << db_path;
            return -1;
        }

        // Populate the vacant ports vector with vacant ports of destroyed containers.
        sqlite::get_vacant_ports(db, vacant_ports);

        return 0;
    }

    /**
     * Do hp related cleanups.
    */
    void deinit()
    {
        if (db != NULL)
            sqlite::close_db(&db);
    }

    /**
     * Create a new instance of hotpocket. A new contract is created and then the docker images is run on that.
     * @param info Structure holding the generated instance info.
     * @param owner_pubkey Public key of the instance owner.
     * @return 0 on success and -1 on error.
    */
    int create_new_instance(instance_info &info, std::string_view owner_pubkey)
    {
        ports instance_ports;
        if (!vacant_ports.empty())
        {
            // Assign a port pair from one of destroyed instances.
            instance_ports = vacant_ports.back();
            last_port_assign_from_vacant = true;
        }
        else
        {
            if (last_port_assign_from_vacant)
            {
                sqlite::get_max_ports(db, last_assigned_ports);
                last_port_assign_from_vacant = false;
            }
            instance_ports = {(uint16_t)(last_assigned_ports.peer_port + 1), (uint16_t)(last_assigned_ports.user_port + 1)};
        }

        const std::string name = crypto::generate_uuid(); // This will be the docker container name as well as the contract folder name.

        if (create_contract(info, name, owner_pubkey, instance_ports) != 0 ||
            run_container(name, instance_ports) != 0 || // Gives 3200 if docker failed.
            sqlite::insert_hp_instance_row(db, info) == -1)
        {
            LOG_ERROR << errno << ": Error creating and running new hp instance for " << owner_pubkey;
            return -1;
        }

        if (last_port_assign_from_vacant)
            vacant_ports.pop_back();
        else
            last_assigned_ports = instance_ports;

        return 0;
    }

    /**
     * Runs a hotpocket docker image on the given contract and the ports.
     * @param folder_name Contract directory folder name.
     * @param assigned_ports Assigned ports to the container.
     * @return 0 on success execution or relavent error code on error.
    */
    int run_container(const std::string &folder_name, const ports &assigned_ports)
    {
        const std::string command = "docker run -t -i -d --network=hpnet --stop-signal=SIGINT --name=" + folder_name + " \
                                            -p " +
                                    std::to_string(assigned_ports.user_port) + ":" + std::to_string(assigned_ports.user_port) + " \
                                            -p " +
                                    std::to_string(assigned_ports.peer_port) + ":" + std::to_string(assigned_ports.peer_port) + " \
                                            --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
                                            --mount type=bind,source=" +
                                    conf::cfg.hp.instance_folder + "/" +
                                    folder_name + ",target=/contract \
                                            hpcore:latest run /contract";

        return system(command.c_str());
    }

    /**
     * Stops the container with given name if exists.
     * @param container_name Name of the container.
     * @return 0 on success execution or relavent error code on error.
    */
    int stop_container(const std::string &container_name)
    {
        instance_info info;
        const int res = sqlite::is_container_exists(db, container_name, info);
        if (res == 0)
        {
            LOG_ERROR << "Given container not found. name: " << container_name;
            return -1;
        }
        else if (info.status != CONTAINER_STATES[STATES::RUNNING])
        {
            LOG_ERROR << "Given container is not running. name: " << container_name;
            return -1;
        }
        const std::string command = "docker stop " + container_name;
        if (system(command.c_str()) != 0 || sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::STOPPED]) == -1)
        {
            LOG_ERROR << "Error when stopping container. name: " << container_name;
            return -1;
        }

        return 0;
    }

    /**
     * Starts the container with given name if exists.
     * @param container_name Name of the container.
     * @return 0 on success execution or relavent error code on error.
    */
    int start_container(const std::string &container_name)
    {
        instance_info info;
        const int res = sqlite::is_container_exists(db, container_name, info);
        if (res == 0)
        {
            LOG_ERROR << "Given container not found. name: " << container_name;
            return -1;
        }
        else if (info.status != CONTAINER_STATES[STATES::STOPPED])
        {
            LOG_ERROR << "Given container is not stopped. name: " << container_name;
            return -1;
        }
        const std::string command = "docker start " + container_name;
        if (system(command.c_str()) != 0 || sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::RUNNING]) == -1)
        {
            LOG_ERROR << "Error when starting container. name: " << container_name;
            return -1;
        }

        return 0;
    }

    /**
     * Destroy the container with given name if exists.
     * @param container_name Name of the container.
     * @return 0 on success execution or relavent error code on error.
    */
    int destroy_container(const std::string &container_name)
    {
        instance_info info;
        const int res = sqlite::is_container_exists(db, container_name, info);
        if (res == 0)
        {
            LOG_ERROR << "Given container not found. name: " << container_name;
            return -1;
        }
        const std::string command = "docker container rm -f " + container_name;
        const std::string folder_path = conf::cfg.hp.instance_folder + "/" + container_name;

        if (system(command.c_str()) != 0 ||
            sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::DESTROYED]) == -1 ||
            util::remove_directory_recursively(folder_path) == -1)
        {
            LOG_ERROR << errno << ": Error destroying container " << container_name;
            return -1;
        }
        // Add the port pair of the destroyed container to the vacant port vector.
        if (std::find(vacant_ports.begin(), vacant_ports.end(), info.assigned_ports) == vacant_ports.end())
            vacant_ports.push_back(info.assigned_ports);
        return 0;
    }

    /**
     * Creates a copy of default contract with the given name and the ports in the instance folder given in the config file.
     * @param info Information of the created contract instance.
     * @param folder_name Folder name for the contract directory.
     * @param owner_pubkey Public key of the owner of the instance.
     * @param assigned_ports Assigned ports to the instance.
     * @return -1 on error and 0 on success.
     * 
    */
    int create_contract(instance_info &info, const std::string &folder_name, std::string_view owner_pubkey, const ports &assigned_ports)
    {
        const std::string folder_path = conf::cfg.hp.instance_folder + "/" + folder_name;
        const std::string command = "cp -r " + conf::ctx.default_contract_path + " " + folder_path;
        if (system(command.c_str()) != 0)
        {
            LOG_ERROR << "Default contract copying failed to " << folder_path;
            return -1;
        }

        // Read the config file into json document object.
        const std::string config_file_path = folder_path + "/cfg/hp.cfg";
        const int config_fd = open(config_file_path.data(), O_RDWR, FILE_PERMS);
        if (config_fd == -1)
        {
            LOG_ERROR << errno << ": Error opening hp config file " << config_file_path;
            return -1;
        }

        std::string buf;
        if (util::read_from_fd(config_fd, buf) == -1)
        {
            std::cerr << "Error reading from the config file. " << errno << '\n';
            close(config_fd);
            return -1;
        }

        jsoncons::ojson d;
        try
        {
            d = jsoncons::ojson::parse(buf, jsoncons::strict_json_parsing());
        }
        catch (const std::exception &e)
        {
            std::cerr << "Invalid config file format. " << e.what() << '\n';
            close(config_fd);
            return -1;
        }
        buf.clear();

        std::string pubkey, seckey;
        crypto::generate_signing_keys(pubkey, seckey);

        const std::string contract_id = crypto::generate_uuid();
        const std::string pubkey_hex = util::to_hex(pubkey);

        d["node"]["public_key"] = pubkey_hex;
        d["node"]["private_key"] = util::to_hex(seckey);
        d["contract"]["id"] = contract_id;
        jsoncons::ojson unl(jsoncons::json_array_arg);
        unl.push_back(util::to_hex(pubkey));
        d["contract"]["unl"] = unl;
        d["contract"]["bin_args"] = owner_pubkey;
        d["mesh"]["port"] = assigned_ports.peer_port;
        d["user"]["port"] = assigned_ports.user_port;

        if (write_json_file(config_fd, d) == -1)
        {
            LOG_ERROR << "Writing modified hp config failed.";
            close(config_fd);
            return -1;
        }
        close(config_fd);

        info.owner_pubkey = owner_pubkey;
        info.ip = "localhost";
        info.contract_id = contract_id;
        info.name = folder_name;
        info.pubkey = pubkey_hex;
        info.assigned_ports = assigned_ports;
        info.status = CONTAINER_STATES[STATES::RUNNING];
        return 0;
    }

    /**
     * Writes the given json doc to a file.
     * @param fd File descriptor to the open file.
     * @param d A valid JSON document.
     * @return 0 on success. -1 on failure.
     */
    int write_json_file(const int fd, const jsoncons::ojson &d)
    {
        std::string json;
        // Convert json object to a string.
        try
        {
            jsoncons::json_options options;
            options.object_array_line_splits(jsoncons::line_split_kind::multi_line);
            options.spaces_around_comma(jsoncons::spaces_option::no_spaces);
            std::ostringstream os;
            os << jsoncons::pretty_print(d, options);
            json = os.str();
            os.clear();
        }
        catch (const std::exception &e)
        {
            LOG_ERROR << "Converting modified hp config json to string failed. ";
            return -1;
        }

        if (ftruncate(fd, 0) == -1 || write(fd, json.data(), json.size()) == -1)
        {
            LOG_ERROR << "Writing modified hp config file failed. ";
            return -1;
        }
        return 0;
    }

} // namespace hp
