#include "hp_manager.hpp"
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
    constexpr int MAX_UNIQUE_NAME_RETRIES = 10; // Max retries before abandoning container uniqueness check.

    sqlite3 *db = NULL; // Database connection for hp related sqlite stuff.

    // Vector keeping vacant ports from destroyed instances.
    std::vector<ports> vacant_ports;

    // This thread will monitor the status of the created instances.
    std::thread hp_monitor_thread;
    bool is_shutting_down = false;

    // We instruct the demon to restart the container automatically once the container exits except manually stopping.
    constexpr const char *DOCKER_CREATE = "DOCKER_HOST=unix:///run/user/$(id -u %s)/docker.sock /usr/bin/sashimono-agent/dockerbin/docker create -t -i --stop-signal=SIGINT --name=%s -p %s:%s -p %s:%s \
                                            --restart unless-stopped --mount type=bind,source=%s,target=/contract hotpocketdev/hotpocket:ubt.20.04 run /contract";
    constexpr const char *DOCKER_START = "DOCKER_HOST=unix:///run/user/$(id -u %s)/docker.sock /usr/bin/sashimono-agent/dockerbin/docker start %s";
    constexpr const char *DOCKER_STOP = "DOCKER_HOST=unix:///run/user/$(id -u %s)/docker.sock /usr/bin/sashimono-agent/dockerbin/docker stop %s";
    constexpr const char *DOCKER_REMOVE = "DOCKER_HOST=unix:///run/user/$(id -u %s)/docker.sock /usr/bin/sashimono-agent/dockerbin/docker rm -f %s";
    constexpr const char *DOCKER_STATUS = "DOCKER_HOST=unix:///run/user/$(id -u %s)/docker.sock /usr/bin/sashimono-agent/dockerbin/docker inspect --format='{{json .State.Status}}' %s";
    constexpr const char *COPY_DIR = "cp -r %s %s";
    constexpr const char *MOVE_DIR = "mv %s %s";
    constexpr const char *CHOWN_DIR = "chown -R %s:%s %s";
    constexpr const char *RUN_SH = "chmod +x %s && sudo bash %s %s"; // Enable execute permission before running in case bash script does not have the permission.

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
        instance_resources.cpu_us = conf::cfg.system.max_cpu_us / conf::cfg.system.max_instance_count;
        instance_resources.mem_kbytes = conf::cfg.system.max_mem_kbytes / conf::cfg.system.max_instance_count;
        instance_resources.storage_kbytes = conf::cfg.system.max_storage_kbytes / conf::cfg.system.max_instance_count;

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
        std::vector<std::pair<const std::string, const std::string>> running_instances;

        util::mask_signal();

        int counter = 0;

        while (!is_shutting_down)
        {
            // Check containers every 1 minute. One minute sleep is not added because if we do so, app will wait until the full
            // time until the app closes in a SIGINT.
            if (counter == 0 || counter == 600)
            {
                sqlite::get_running_instance_user_and_name_list(db, running_instances);
                for (const auto &[username, name] : running_instances)
                {
                    std::string status;
                    const int res = check_instance_status(username, name, status);
                    if (res == 0 && status != CONTAINER_STATES[STATES::RUNNING])
                    {
                        if (docker_start(username, name) == -1)
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
     * Create a new instance of hotpocket. A new contract is created with docker image.
     * @param info Structure holding the generated instance info.
     * @param owner_pubkey Public key of the instance owner.
     * @param contract_id Contract id to be configured.
     * @return 0 on success and -1 on error.
    */
    int create_new_instance(instance_info &info, std::string_view owner_pubkey, const std::string &contract_id)
    {
        // If the max alloved instance count is already allocated. We won't allow more.
        const int allocated_count = sqlite::get_allocated_instance_count(db);
        if (allocated_count == -1)
        {
            LOG_ERROR << "Error getting allocated instance count from db.";
            return -1;
        }
        else if (allocated_count >= conf::cfg.system.max_instance_count)
        {
            LOG_ERROR << "Max instance count is reached.";
            return -1;
        }

        LOG_INFO << "Resources for instance - CPU: " << instance_resources.cpu_us << " MicroS, RAM: " << instance_resources.mem_kbytes << " KB, Storage: " << instance_resources.storage_kbytes << " KB.";

        // First check whether contract_id is valid uuid.
        if (!crypto::verify_uuid(contract_id))
        {
            LOG_ERROR << "Provided contract id is not a valid uuid.";
            return -1;
        }

        std::string container_name = crypto::generate_uuid(); // This will be the docker container name as well as the contract folder name.
        int retries = 0;
        // If the generated uuid is already assigned to a container, we try generating a
        // unique uuid with max tries limited under a threshold.
        while (sqlite::is_container_exists(db, container_name, info) == 1)
        {
            if (retries >= MAX_UNIQUE_NAME_RETRIES)
            {
                LOG_ERROR << "Could not find a unique container name. Threshold of " << MAX_UNIQUE_NAME_RETRIES << " exceeded";
                return -1;
            }
            container_name = crypto::generate_uuid();
            retries++;
        }

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

        int user_id;
        std::string username;
        if (install_user(user_id, username, instance_resources.cpu_us, instance_resources.mem_kbytes, instance_resources.storage_kbytes) == -1)
            return -1;

        const std::string contract_dir = util::get_user_contract_dir(username, container_name);

        if (create_contract(username, owner_pubkey, contract_id, contract_dir, instance_ports, info) == -1 ||
            create_container(username, container_name, contract_dir, instance_ports, info) == -1)
        {
            LOG_ERROR << "Error creating hp instance for " << owner_pubkey;
            // Remove user if instance creation failed.
            uninstall_user(username);
            return -1;
        }

        if (sqlite::insert_hp_instance_row(db, info) == -1)
        {
            LOG_ERROR << "Error creating hp instance for " << owner_pubkey;
            // Remove container and uninstall user if database update failed.
            docker_remove(username, container_name);
            uninstall_user(username);
            return -1;
        }

        if (last_port_assign_from_vacant)
            vacant_ports.pop_back();
        else
            last_assigned_ports = instance_ports;

        return 0;
    }

    /**
     * Initiate the instance. The config will be updated and container will be started.
     * @param container_name Name of the container.
     * @param config_msg Config values for the hp instance.
     * @return 0 on success and -1 on error.
    */
    int initiate_instance(std::string_view container_name, const msg::initiate_msg &config_msg)
    {
        instance_info info;
        const int res = sqlite::is_container_exists(db, container_name, info);
        if (res == 0)
        {
            LOG_ERROR << "Given container not found. name: " << container_name;
            return -1;
        }
        else if (info.status != CONTAINER_STATES[STATES::CREATED])
        {
            LOG_ERROR << "Given container is already initiated. name: " << container_name;
            return -1;
        }

        // Read the config file into json document object.
        const std::string contract_dir = util::get_user_contract_dir(info.username, container_name);
        std::string config_file_path(contract_dir);
        config_file_path.append("/cfg/hp.cfg");
        const int config_fd = open(config_file_path.data(), O_RDWR, FILE_PERMS);
        if (config_fd == -1)
        {
            LOG_ERROR << errno << ": Error opening hp config file " << config_file_path;
            return -1;
        }

        jsoncons::ojson d;
        std::string hpfs_log_level;
        bool is_full_history;
        if (util::read_json_file(config_fd, d) == -1 ||
            write_json_values(d, config_msg) == -1 ||
            read_json_values(d, hpfs_log_level, is_full_history) == -1 ||
            util::write_json_file(config_fd, d) == -1 ||
            hpfs::start_fs_processes(info.username, contract_dir, hpfs_log_level, is_full_history) == -1)
        {
            LOG_ERROR << "Error when setting up container. name: " << container_name;
            close(config_fd);
            return -1;
        }
        close(config_fd);

        if (docker_start(info.username, container_name) == -1)
        {
            LOG_ERROR << "Error when starting container. name: " << container_name;
            // Stop started hpfs processes if starting instance failed.
            hpfs::stop_fs_processes(info.username);
            return -1;
        }

        if (sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::RUNNING]) == -1)
        {
            LOG_ERROR << "Error when starting container. name: " << container_name;
            // Stop started docker and hpfs processes if database update fails.
            docker_stop(info.username, container_name);
            hpfs::stop_fs_processes(info.username);
            return -1;
        }

        return 0;
    }

    /**
     * Creates a hotpocket docker image on the given contract and the ports.
     * @param username Username of the instance user.
     * @param container_name Name of the container.
     * @param contract_dir Directory for the contract.
     * @param assigned_ports Assigned ports to the container.
     * @return 0 on success execution or relavent error code on error.
    */
    int create_container(std::string_view username, std::string_view container_name, std::string_view contract_dir, const ports &assigned_ports, instance_info &info)
    {
        const std::string user_port = std::to_string(assigned_ports.user_port);
        const std::string peer_port = std::to_string(assigned_ports.peer_port);
        const int len = 303 + username.length() + container_name.length() + (user_port.length() * 2) + (peer_port.length() * 2) + contract_dir.length();
        char command[len];
        sprintf(command, DOCKER_CREATE, username.data(), container_name.data(), user_port.data(), user_port.data(), peer_port.data(), peer_port.data(), contract_dir.data());
        if (system(command) != 0)
        {
            LOG_ERROR << "Error when running container. name: " << container_name;
            return -1;
        }

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

        if (docker_stop(info.username, container_name) == -1 ||
            sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::STOPPED]) == -1 ||
            hpfs::stop_fs_processes(info.username) == -1)
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

        // Read the config file into json document object.
        const std::string contract_dir = util::get_user_contract_dir(info.username, container_name);
        std::string config_file_path(contract_dir);
        config_file_path.append("/cfg/hp.cfg");
        const int config_fd = open(config_file_path.data(), O_RDONLY);
        if (config_fd == -1)
        {
            LOG_ERROR << errno << ": Error opening hp config file " << config_file_path;
            return -1;
        }

        jsoncons::ojson d;
        std::string hpfs_log_level;
        bool is_full_history;
        if (util::read_json_file(config_fd, d) == -1 ||
            read_json_values(d, hpfs_log_level, is_full_history) == -1 ||
            hpfs::start_fs_processes(info.username, contract_dir, hpfs_log_level, is_full_history) == -1)
        {
            LOG_ERROR << "Error when setting up container. name: " << container_name;
            close(config_fd);
            return -1;
        }
        close(config_fd);

        if (docker_start(info.username, container_name) == -1)
        {
            LOG_ERROR << "Error when starting container. name: " << container_name;
            // Stop started hpfs processes if starting instance failed.
            hpfs::stop_fs_processes(info.username);
            return -1;
        }

        if (sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::RUNNING]) == -1)
        {
            LOG_ERROR << "Error when starting container. name: " << container_name;
            // Stop started docker and hpfs processes if database update fails.
            docker_stop(info.username, container_name);
            hpfs::stop_fs_processes(info.username);
            return -1;
        }

        return 0;
    }

    /**
     * Execute docker start <container_name> command.
     * @param username Username of the instance user.
     * @param container_name Name of the container.
     * @return 0 on successful execution and -1 on error.
    */
    int docker_start(std::string_view username, std::string_view container_name)
    {
        const int len = 100 + username.length() + container_name.length();
        char command[len];
        sprintf(command, DOCKER_START, username.data(), container_name.data());
        return system(command) == 0 ? 0 : -1;
    }

    /**
     * Execute docker stop <container_name> command.
     * @param username Username of the instance user.
     * @param container_name Name of the container.
     * @return 0 on successful execution and -1 on error.
    */
    int docker_stop(std::string_view username, std::string_view container_name)
    {
        const int len = 99 + username.length() + container_name.length();
        char command[len];
        sprintf(command, DOCKER_STOP, username.data(), container_name.data());
        return system(command) == 0 ? 0 : -1;
    }

    /**
     * Execute docker rm <container_name> command.
     * @param username Username of the instance user.
     * @param container_name Name of the container.
     * @return 0 on successful execution and -1 on error.
    */
    int docker_remove(std::string_view username, std::string_view container_name)
    {
        const int len = 100 + username.length() + container_name.length();
        char command[len];
        sprintf(command, DOCKER_REMOVE, username.data(), container_name.data());
        return system(command) == 0 ? 0 : -1;
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

        if (docker_remove(info.username, container_name) == -1 ||
            sqlite::update_status_in_container(db, container_name, CONTAINER_STATES[STATES::DESTROYED]) == -1 ||
            hpfs::stop_fs_processes(info.username) == -1)
        {
            LOG_ERROR << errno << ": Error destroying container " << container_name;
            return -1;
        }
        // Add the port pair of the destroyed container to the vacant port vector.
        if (std::find(vacant_ports.begin(), vacant_ports.end(), info.assigned_ports) == vacant_ports.end())
            vacant_ports.push_back(info.assigned_ports);

        // Remove user after destroying.
        if (uninstall_user(info.username) == -1)
            return -1;

        return 0;
    }

    /**
     * Creates a copy of default contract with the given name and the ports in the instance folder given in the config file.
     * @param username Name of the instance user.
     * @param owner_pubkey Public key of the owner of the instance.
     * @param contract_id Contract id to be configured.
     * @param contract_dir Directory of the contract.
     * @param assigned_ports Assigned ports to the instance.
     * @param info Information of the created contract instance.
     * @return -1 on error and 0 on success.
     * 
    */
    int create_contract(std::string_view username, std::string_view owner_pubkey, std::string_view contract_id,
                        std::string_view contract_dir, const ports &assigned_ports, instance_info &info)
    {
        // Creating a temporary directory to do the config manipulations before moved to the contract dir.
        // Folders inside /tmp directory will be cleaned after a reboot. So this will self cleanup folders
        // that might be remaining due to another error in the workflow.
        char templ[17] = "/tmp/sashiXXXXXX";
        const char *temp_dirpath = mkdtemp(templ);
        if (temp_dirpath == NULL)
        {
            LOG_ERROR << errno << ": Error creating temporary directory to create contract folder.";
            return -1;
        }
        const std::string source_path = conf::ctx.contract_template_path + "/*";
        int len = 25 + source_path.length();
        char cp_command[len];
        sprintf(cp_command, COPY_DIR, source_path.data(), temp_dirpath);
        if (system(cp_command) == -1)
        {
            LOG_ERROR << errno << ": Default contract copying failed to " << temp_dirpath;
            return -1;
        }

        const std::string config_dir = std::string(temp_dirpath) + "/cfg";

        // Read the config file into json document object.
        const std::string config_file_path = config_dir + "/hp.cfg";
        const int config_fd = open(config_file_path.data(), O_RDWR, FILE_PERMS);

        if (config_fd == -1)
        {
            LOG_ERROR << errno << ": Error opening hp config file " << config_file_path;
            return -1;
        }

        jsoncons::ojson d;
        if (util::read_json_file(config_fd, d) == -1)
        {
            close(config_fd);
            return -1;
        }

        std::string pubkey, seckey;
        crypto::generate_signing_keys(pubkey, seckey);

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
        d["contract"]["bin_path"] = "bootstrap_contract";
        d["contract"]["bin_args"] = owner_pubkey;
        d["mesh"]["port"] = assigned_ports.peer_port;
        d["user"]["port"] = assigned_ports.user_port;
        d["hpfs"]["external"] = true;

        if (util::write_json_file(config_fd, d) == -1)
        {
            LOG_ERROR << "Writing modified hp config failed.";
            close(config_fd);
            return -1;
        }
        close(config_fd);

        // Generate tls key files using openssl command is available.
        const std::string tls_command = "openssl req -newkey rsa:2048 -new -nodes -x509 -days 365 -keyout " +
                                        config_dir + "/tlskey.pem" + " -out " + config_dir + "/tlscert.pem " +
                                        "-subj \"/C=HP/ST=HP/L=HP/O=HP/CN=" + pubkey_hex + ".hotpocket.contract\" > /dev/null 2>&1";
        if (system(tls_command.c_str()) == -1)
        {
            LOG_ERROR << errno << ": Error generting tls key files at " << config_dir;
            return -1;
        }

        // Move the contract to contract dir
        len = 22 + contract_dir.length();
        char mv_command[len];
        sprintf(mv_command, MOVE_DIR, temp_dirpath, contract_dir.data());
        if (system(mv_command) != 0)
        {
            LOG_ERROR << "Default contract moving failed to " << contract_dir;
            return -1;
        }

        // Transfer ownership to the instance user.
        len = 12 + (username.length() * 2) + contract_dir.length();
        char own_command[len];
        sprintf(own_command, CHOWN_DIR, username.data(), username.data(), contract_dir.data());
        if (system(own_command) != 0)
        {
            LOG_ERROR << "Changing contract ownership failed " << contract_dir;
            return -1;
        }

        info.owner_pubkey = owner_pubkey;
        info.username = username;
        info.contract_dir = contract_dir;
        info.ip = conf::cfg.hp.host_address;
        info.contract_id = contract_id;
        info.pubkey = pubkey_hex;
        info.assigned_ports = assigned_ports;
        info.status = CONTAINER_STATES[STATES::CREATED];
        return 0;
    }

    /**
     * Check the status of the given container using docker inspect command.
     * @param username Username of the instance user.
     * @param container_name Name of the container.
     * @param status The variable that holds the status of the container.
     * @return 0 on success and -1 on error.
    */
    int check_instance_status(std::string_view username, std::string_view container_name, std::string &status)
    {
        const int len = 136 + username.length() + container_name.length();
        char command[len];
        sprintf(command, DOCKER_STATUS, username.data(), container_name.data());

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
     * @param d Json file to be read.
     * @param hpfs_log_level Hpfs log level.
     * @param is_full_history Contract history mode.
     * @return 0 on success. -1 on failure.
     */
    int read_json_values(const jsoncons::ojson &d, std::string &hpfs_log_level, bool &is_full_history)
    {
        try
        {
            hpfs_log_level = d["hpfs"]["log"]["log_level"].as<std::string>();
        }
        catch (const std::exception &e)
        {
            LOG_ERROR << "Invalid contract config hpfs log. " << e.what();
            return -1;
        }

        const std::unordered_set<std::string> valid_loglevels({"dbg", "inf", "wrn", "err"});
        if (valid_loglevels.count(hpfs_log_level) != 1)
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

    /**
     * Write contract config values (only updated if provided config values are not empty) into the json file.
     * @param d Json file to be populated.
     * @param config_msg Config values to be updated.
     * @return 0 on success. -1 on failure.
     */
    int write_json_values(jsoncons::ojson &d, const msg::initiate_msg &config_msg)
    {
        if (!config_msg.unl.empty())
        {
            jsoncons::ojson unl(jsoncons::json_array_arg);
            for (auto &pubkey : config_msg.unl)
                unl.push_back(util::to_hex(pubkey));
            d["contract"]["unl"] = unl;
        }

        if (!config_msg.peers.empty())
        {
            jsoncons::ojson peers(jsoncons::json_array_arg);
            for (auto &peer : config_msg.peers)
                peers.push_back(peer.host_address + ":" + std::to_string(peer.port));
            d["mesh"]["known_peers"] = peers;
        }

        if (!config_msg.role.empty())
        {
            if (config_msg.role != "observer" && config_msg.role != "validator")
            {
                LOG_ERROR << "Invalid role value observer|validator";
                return -1;
            }
            d["node"]["role"] = config_msg.role;
        }

        if (!config_msg.history.empty())
        {
            if (config_msg.history != "full" && config_msg.history != "custom")
            {
                LOG_ERROR << "Invalid history value full|custom";
                return -1;
            }
            d["node"]["history"] = config_msg.history;
        }

        if (config_msg.max_primary_shards.has_value())
            d["node"]["history_config"]["max_primary_shards"] = config_msg.max_primary_shards.value();

        if (config_msg.max_raw_shards.has_value())
            d["node"]["history_config"]["max_raw_shards"] = config_msg.max_raw_shards.value();

        if (d["node"]["history"].as<std::string>() == "custom" && d["node"]["history_config"]["max_primary_shards"].as<uint64_t>() == 0)
        {
            LOG_ERROR << "'max_primary_shards' cannot be zero in history=custom mode.";
            return -1;
        }

        return 0;
    }

    /**
     * Executes the given bash file and populates final comma seperated output into a vector.
     * @param file_name Name of the bash script.
     * @param output_params Final output of the bash script.
     * @param input_params Input parameters to the bash script (Optional).
    */
    int execute_bash_file(std::string_view file_name, std::vector<std::string> &output_params, const std::vector<std::string_view> &input_params)
    {
        std::string params = "";
        for (auto itr = input_params.begin(); itr != input_params.end(); itr++)
        {
            params.append(*itr);
            if (std::next(itr) != input_params.end())
                params.append(" ");;
        }
        const int len = 23 + (file_name.length() * 2) + params.length();
        char command[len];
        sprintf(command, RUN_SH, file_name.data(), file_name.data(), params.empty() ? "\0" : params.data());

        FILE *fpipe = popen(command, "r");
        if (fpipe == NULL)
        {
            LOG_ERROR << "Error on popen for command " << std::string(command);
            return -1;
        }

        char buffer[200];
        std::string output;

        // Only take the last cout string It contains the output of the execution.
        while (fgets(buffer, sizeof(buffer), fpipe) != NULL)
        {
            output = buffer;
            // Replace ending new line character at the end of the log line.
            if (!output.empty())
            {
                if (output.back() == '\n')
                    output.pop_back();
                LOG_DEBUG << output;
            }
        }

        pclose(fpipe);
        util::split_string(output_params, output, ",");
        return 0;
    }

    /**
     * Create new user and install dependencies and populate id and username.
     * @param user_id Uid of the created user to be populated.
     * @param username Username of the created user to be populated.
     * @param max_cpu_us CPU quota allowed for this user.
     * @param max_mem_kbytes Memory quota allowed for this user.
     * @param storage_kbytes Disk quota allowed for this user.
    */
    int install_user(int &user_id, std::string &username, const size_t max_cpu_us, const size_t max_mem_kbytes, const size_t storage_kbytes)
    {
        const std::vector<std::string_view> input_params = {std::to_string(max_cpu_us), std::to_string(max_mem_kbytes), std::to_string(storage_kbytes)};
        std::vector<std::string> output_params;
        if (execute_bash_file(conf::ctx.user_install_sh, output_params, input_params) == -1)
            return -1;

        if (strncmp(output_params.at(output_params.size() - 1).data(), "INST_SUC", 8) == 0) // If success.
        {
            if (util::stoi(output_params.at(0), user_id) == -1)
            {
                LOG_ERROR << "Create user error: Invalid user id.";
                return -1;
            }
            username = output_params.at(1);
            LOG_DEBUG << "Created new user : " << username << ", uid : " << user_id;
            return 0;
        }
        else if (strncmp(output_params.at(output_params.size() - 1).data(), "INST_ERR", 8) == 0) // If error.
        {
            const std::string error = output_params.at(0);
            LOG_ERROR << "User creation error : " << error;
            return -1;
        }
        else
        {
            const std::string error = output_params.at(0);
            LOG_ERROR << "Unknown user creation error : " << error;
            return -1;
        }
    }

    /**
     * Delete the given user and remove dependencies.
     * @param username Username of the user to be deleted.
    */
    int uninstall_user(std::string_view username)
    {
        const std::vector<std::string_view> input_params = {username};
        std::vector<std::string> output_params;
        if (execute_bash_file(conf::ctx.user_uninstall_sh, output_params, input_params) == -1)
            return -1;

        // const std::string contract_dir = util::get_user_contract_dir(info.username, container_name);
        if (strncmp(output_params.at(output_params.size() - 1).data(), "UNINST_SUC", 8) == 0) // If success.
        {
            LOG_DEBUG << "Deleted the user : " << username;
            return 0;
        }
        if (strncmp(output_params.at(output_params.size() - 1).data(), "UNINST_ERR", 8) == 0) // If error.
        {
            const std::string error = output_params.at(0);
            LOG_ERROR << "User removing error : " << error;
            return -1;
        }
        else
        {
            const std::string error = output_params.at(0);
            LOG_ERROR << "Unknown user removing error : " << error;
            return -1;
        }
    }

} // namespace hp
