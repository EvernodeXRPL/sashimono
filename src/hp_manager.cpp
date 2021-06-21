#include "hp_manager.hpp"
#include "conf.hpp"
#include "crypto.hpp"
#include "util/util.hpp"
#include "sqlite.hpp"

namespace hp
{
    // Keep track of the ports of the most recent hp instance.
    ports last_assigned_ports;

    resources instance_resources;

    // This is defaults to true because it initialize last assigned ports when a new instance is created if there is no vacant ports available.
    bool last_port_assign_from_vacant = true;

    constexpr int FILE_PERMS = 0644;

    sqlite3 *db = NULL; // Database connection for hp related sqlite stuff.

    // Vector keeping vacant ports from destroyed instances.
    std::vector<ports> vacant_ports;

    // This thread will monitor the status of the created instances.
    std::thread hp_monitor_thread;
    bool is_shutting_down = false;

    // This postfix is used for the container name. Ex: sashi1-hpcontainer.
    constexpr const char *CONTAINER_POSTFIX = "-hpcontainer";
    // We instruct the demon to restart the container automatically once the container exits except manually stopping.
    constexpr const char *DOCKER_RUN = "DOCKER_HOST=unix:///run/user/%s/docker.sock /usr/bin/sashimono-agent/dockerbin/docker run -t -i -d --stop-signal=SIGINT --name=%s -p %s:%s -p %s:%s \
                                            --restart unless-stopped --mount type=bind,source=%s,target=/contract ravinsp/hotpocket:ubt.20.04-njs.14 run /contract";
    constexpr const char *DOCKER_START = "DOCKER_HOST=unix:///run/user/%s/docker.sock /usr/bin/sashimono-agent/dockerbin/docker start %s";
    constexpr const char *DOCKER_STOP = "DOCKER_HOST=unix:///run/user/%s/docker.sock /usr/bin/sashimono-agent/dockerbin/docker stop %s";
    constexpr const char *DOCKER_REMOVE = "DOCKER_HOST=unix:///run/user/%s/docker.sock /usr/bin/sashimono-agent/dockerbin/docker rm -f %s";
    constexpr const char *DOCKER_STATUS = "DOCKER_HOST=unix:///run/user/%s/docker.sock /usr/bin/sashimono-agent/dockerbin/docker inspect --format='{{json .State.Status}}' %s";
    constexpr const char *COPY_DIR = "cp -r %s %s";
    constexpr const char *OWN_DIR = "chown -R %s:%s %s";

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

        // Monitor thread is temperory disabled until the implementation details are finalized.
        // hp_monitor_thread = std::thread(hp_monitor_loop);

        // Calculate the resources per instance.
        instance_resources.cpu_micro_seconds = conf::cfg.system.max_cpu_micro_seconds / conf::cfg.system.max_instance_count;
        instance_resources.mem_bytes = conf::cfg.system.max_mem_bytes / conf::cfg.system.max_instance_count;
        instance_resources.storage_bytes = conf::cfg.system.max_storage_bytes / conf::cfg.system.max_instance_count;

        return 0;
    }

    /**
     * Do hp related cleanups.
    */
    void deinit()
    {
        is_shutting_down = true;
        if (hp_monitor_thread.joinable())
            hp_monitor_thread.join();

        if (db != NULL)
            sqlite::close_db(&db);
    }

    /**
     * Monitoring created container status. If any containers are crashed, then they are respawned.
     * If the respawn fails, the current_status field is updated to 'exited' in the database.
    */
    void hp_monitor_loop()
    {
        LOG_INFO << "HP instance monitor started.";
        std::vector<std::pair<const int, const std::string>> running_instances;

        util::mask_signal();

        int counter = 0;

        while (!is_shutting_down)
        {
            // Check containers every 1 minute. One minute sleep is not added because if we do so, app will wait until the full
            // time until the app closes in a SIGINT.
            if (counter == 0 || counter == 600)
            {
                sqlite::get_running_instance_uid_name_list(db, running_instances);
                for (const auto &[uid, name] : running_instances)
                {
                    std::string status;
                    const int res = check_instance_status(uid, name, status);
                    if (res == 0 && status != CONTAINER_STATES[STATES::RUNNING])
                    {
                        if (docker_start(uid, name) == -1)
                        {
                            // We only change the current status variable from the monitor loop.
                            // We try to start this container in next iteration as well untill the desired state is achieved.
                            if (sqlite::update_current_status_in_container(db, name, CONTAINER_STATES[STATES::EXITED]) == 0)
                                LOG_INFO << "Re-spinning " + name + " failed. Current status updated to 'exited' in DB.";
                        }
                        else
                        {
                            // Make the current field NULL because the instance is healthy now.
                            if (sqlite::update_current_status_in_container(db, name, {}) == 0)
                                LOG_INFO << "Re-spinning " + name + " successful.";
                        }
                    }
                }
                counter = 0;
            }
            counter++;
            util::sleep(100);
        }

        LOG_INFO << "HP instance monitor stopped.";
    }

    /**
     * Create a new instance of hotpocket. A new contract is created and then the docker images is run on that.
     * @param info Structure holding the generated instance info.
     * @param owner_pubkey Public key of the instance owner.
     * @return 0 on success and -1 on error.
    */
    int create_new_instance(instance_info &info, std::string_view owner_pubkey)
    {
        LOG_INFO << "Resources for instance - CPU: " << instance_resources.cpu_micro_seconds << " MicroS, RAM: " << instance_resources.mem_bytes << " Bytes, Storage: " << instance_resources.storage_bytes << " Bytes.";

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

        const std::string command = "sudo sh " + conf::ctx.user_install_sh;
        FILE *fpipe = popen(command.c_str(), "r");

        if (fpipe == NULL)
        {
            LOG_ERROR << "Error on popen for command " << std::string(command);
            return -1;
        }
        std::string output;
        output.resize(1024);

        fgets(output.data(), 20, fpipe);
        std::vector<std::string> params;
        util::split_string(params, output, "\n");
        output = params.at(params.size() - 1);
        util::split_string(params, output, ",");

        uint64_t user_id = 0;
        std::string username;
        std::string socket;
        const std::string status = params.at(params.size() - 1);
        if (status == "INST_SUC") // If success.
        {
            if (util::stoull(params.at(0), user_id) == -1)
            {
                LOG_ERROR << "Create user error: Invalid user id.";
                return -1;
            }
            user_id = stoi(params.at(0));
            username = params.at(1);
            socket = params.at(2);
        }
        else if (status == "INST_ERR") // If error.
        {
            std::string error = params.at(0);
            LOG_ERROR << "User creation error : " << error;
            return -1;
        }
        else
        {
            std::string error = params.at(0);
            LOG_ERROR << "Unknown user creation error";
            return -1;
        }

        if (pclose(fpipe) == 0)
            return 0;
        else
            return -1;

        // TODO: user home can be obtained by eval echo "~$USER"
        const std::string contract_dir = util::get_user_contract_dir(username);
        const std::string container_name = crypto::generate_uuid(); // This will be the docker container name as well as the contract folder name.

        std::string hpfs_log_level;
        bool is_full_history;
        if (create_contract(username, contract_dir, owner_pubkey, instance_ports, info) != 0 ||
            read_contract_cfg_values(contract_dir, hpfs_log_level, is_full_history) == -1 ||
            hpfs::start_fs_processes(user_id, contract_dir, hpfs_log_level, is_full_history) == -1 ||
            run_container(user_id, container_name, contract_dir, instance_ports, info) != 0 || // Gives 3200 if docker failed.
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
     * @param user_id ID of the instance user.
     * @param container_name Name of the container.
     * @param contract_dir Directory for the contract.
     * @param assigned_ports Assigned ports to the container.
     * @return 0 on success execution or relavent error code on error.
    */
    int run_container(const int user_id, std::string_view container_name, std::string_view contract_dir, const ports &assigned_ports, instance_info &info)
    {
        const std::string user_id_str = std::to_string(user_id);
        const std::string user_port = std::to_string(assigned_ports.user_port);
        const std::string peer_port = std::to_string(assigned_ports.peer_port);
        const int len = 262 + user_id_str.length() + container_name.length() + (user_port.length() * 2) + (peer_port.length() * 2) + contract_dir.length();
        char command[len];
        sprintf(command, DOCKER_RUN, user_id_str.data(), container_name.data(), user_port.data(), user_port.data(), peer_port.data(), peer_port.data(), contract_dir.data());
        if (system(command) != 0)
        {
            LOG_ERROR << "Error when running container. name: " << container_name;
            return -1;
        }

        info.user_id = user_id;
        info.container_name = container_name;
        info.contract_dir = contract_dir;
        return 0;
    }

    /**
     * Stops the container with given name if exists.
     * @param container_name Name of the container.
     * @return 0 on success execution or relavent error code on error.
    */
    int stop_container(std::string_view container_name)
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

        const std::string user_id_str = std::to_string(info.user_id);
        const int len = 54 + user_id_str.length() + container_name.length();
        char command[len];
        sprintf(command, DOCKER_STOP, user_id_str.data(), container_name.data());

        if (system(command) != 0 || sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::STOPPED]) == -1)
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
    int start_container(std::string_view container_name)
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

        std::string hpfs_log_level;
        bool is_full_history;
        const std::string contract_dir = util::get_user_contract_dir(info.username);
        if (read_contract_cfg_values(contract_dir, hpfs_log_level, is_full_history) == -1 ||
            hpfs::start_fs_processes(info.user_id, contract_dir, hpfs_log_level, is_full_history) == -1 ||
            docker_start(info.user_id, container_name) != 0 ||
            sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::RUNNING]) == -1)
        {
            LOG_ERROR << "Error when starting container. name: " << container_name;
            return -1;
        }

        return 0;
    }

    /**
     * Execute docker start <container_name> command.
     * @param user_id ID of the instance user.
     * @param container_name Name of the container.
     * @return 0 on successful execution and -1 on error.
    */
    int docker_start(const int user_id, std::string_view container_name)
    {
        const std::string user_id_str = std::to_string(user_id);
        const int len = 56 + user_id_str.length() + container_name.length();
        char command[len];
        sprintf(command, DOCKER_START, user_id_str.data(), container_name.data());
        const int res = system(command);
        return res == 0 ? 0 : -1;
    }

    /**
     * Destroy the container with given name if exists.
     * @param container_name Name of the container.
     * @return 0 on success execution or relavent error code on error.
    */
    int destroy_container(std::string_view container_name)
    {
        instance_info info;
        const int res = sqlite::is_container_exists(db, container_name, info);
        if (res == 0)
        {
            LOG_ERROR << "Given container not found. name: " << container_name;
            return -1;
        }

        const std::string user_id_str = std::to_string(info.user_id);
        const int len = 56 + user_id_str.length() + container_name.length();
        char command[len];
        sprintf(command, DOCKER_REMOVE, user_id_str.data(), container_name.data());
        const std::string contract_dir = util::get_user_contract_dir(info.username);
        if (system(command) != 0 ||
            sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::DESTROYED]) == -1 ||
            util::remove_directory_recursively(contract_dir) == -1)
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
     * @param username Name of the instance user.
     * @param contract_dir Directory of the contract.
     * @param owner_pubkey Public key of the owner of the instance.
     * @param assigned_ports Assigned ports to the instance.
     * @param info Information of the created contract instance.
     * @return -1 on error and 0 on success.
     * 
    */
    int create_contract(std::string_view username, std::string_view contract_dir, std::string_view owner_pubkey, const ports &assigned_ports, instance_info &info)
    {
        int len = 8 + conf::ctx.default_contract_path.length() + contract_dir.length();
        char cp_command[len];
        sprintf(cp_command, COPY_DIR, conf::ctx.default_contract_path.data(), contract_dir.data());
        if (system(cp_command) != 0)
        {
            LOG_ERROR << "Default contract copying failed to " << contract_dir;
            return -1;
        }

        // Read the config file into json document object.
        std::string config_file_path(contract_dir);
        config_file_path.append("/cfg/hp.cfg");
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

        // Default hp.cfg configs.
        d["node"]["history_config"]["max_primary_shards"] = 2;
        d["node"]["history_config"]["max_raw_shards"] = 2;
        d["hpfs"]["log"]["log_level"] = "err";
        d["log"]["log_level"] = "inf";
        d["log"]["max_mbytes_per_file"] = 5;
        d["log"]["max_file_count"] = 10;

        d["node"]["public_key"] = pubkey_hex;
        d["node"]["private_key"] = util::to_hex(seckey);
        d["contract"]["id"] = contract_id;
        jsoncons::ojson unl(jsoncons::json_array_arg);
        unl.push_back(util::to_hex(pubkey));
        d["contract"]["unl"] = unl;
        d["contract"]["bin_args"] = owner_pubkey;
        d["mesh"]["port"] = assigned_ports.peer_port;
        d["user"]["port"] = assigned_ports.user_port;
        d["hpfs"]["external"] = true;

        if (write_json_file(config_fd, d) == -1)
        {
            LOG_ERROR << "Writing modified hp config failed.";
            close(config_fd);
            return -1;
        }
        close(config_fd);

        len = 12 + (username.length() * 2) + contract_dir.length();
        char own_command[len];
        sprintf(own_command, OWN_DIR, username.data(), username.data(), contract_dir.data());
        if (system(cp_command) != 0)
        {
            LOG_ERROR << "Changing contract ownership failed " << contract_dir;
            return -1;
        }

        info.username = username;
        info.contract_dir = contract_dir;
        info.ip = "localhost";
        info.contract_id = contract_id;
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

    /**
     * Check the status of the given container using docker inspect command.
     * @param user_id ID of the instance user.
     * @param container_name Name of the container.
     * @param status The variable that holds the status of the container.
     * @return 0 on success and -1 on error.
    */
    int check_instance_status(const int user_id, std::string_view container_name, std::string &status)
    {
        const std::string user_id_str = std::to_string(user_id);
        const int len = 92 + user_id_str.length() + container_name.length();
        char command[len];
        sprintf(command, DOCKER_STATUS, user_id_str.data(), container_name.data());

        FILE *fpipe = popen(command, "r");

        if (fpipe == NULL)
        {
            LOG_ERROR << "Error on popen for command " << std::string(command);
            return -1;
        }
        char buffer[20];

        fgets(buffer, 20, fpipe);

        status = buffer;
        status = status.substr(1, status.length() - 3);

        if (pclose(fpipe) == 0)
            return 0;
        else
            return -1;
    }

    /**
     * Read only required contract config values
     * @param contract_dir Directory of the contract.
     * @param log_level Log level to be read.
     * @param is_full_history Contract history mode.
     * @return 0 on success. -1 on failure.
     */
    int read_contract_cfg_values(std::string_view contract_dir, std::string &log_level, bool &is_full_history)
    {
        // Read the config file into json document object.
        std::string config_file_path(contract_dir);
        config_file_path.append("/cfg/hp.cfg");
        const int config_fd = open(config_file_path.data(), O_RDONLY);
        if (config_fd == -1)
        {
            LOG_ERROR << errno << ": Error opening hp config file " << config_file_path;
            return -1;
        }

        std::string buf;
        if (util::read_from_fd(config_fd, buf) == -1)
        {
            LOG_ERROR << "Error reading from the config file. " << errno;
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
            LOG_ERROR << "Invalid contract config file format. " << e.what();
            return -1;
        }
        buf.clear();

        try
        {
            log_level = d["hpfs"]["log"]["log_level"].as<std::string>();
        }
        catch (const std::exception &e)
        {
            LOG_ERROR << "Invalid contract config hpfs log. " << e.what();
            return -1;
        }

        const std::unordered_set<std::string> valid_loglevels({"dbg", "inf", "wrn", "err"});
        if (valid_loglevels.count(log_level) != 1)
        {
            LOG_ERROR << "Invalid hpfs loglevel configured. Valid values: dbg|inf|wrn|err";
            return -1;
        }

        try
        {
            if (d["node"]["history"] == "full")
                is_full_history = true;
            else if (d["node"]["history"] == "custom")
                is_full_history = false;
            else
            {
                LOG_ERROR << "Invalid history mode. 'full' or 'custom' expected.";
                return -1;
            }
        }
        catch (const std::exception &e)
        {
            LOG_ERROR << "Invalid contract config history mode. " << e.what();
            return -1;
        }

        return 0;
    }

} // namespace hp
