#include "hp_manager.hpp"
#include "conf.hpp"
#include "crypto.hpp"
#include "util/util.hpp"

namespace hp
{
    uint16_t pub_port_posfix = 1;
    uint16_t peer_port_posfix = 1;

    constexpr int FILE_PERMS = 0644;

    int create_new_instance(instance_info &info, std::string_view owner_pubkey)
    {
        const uint16_t pub_port = 8080 + pub_port_posfix;
        const uint16_t peer_port = 22860 + peer_port_posfix;

        const std::string name = crypto::generate_uuid(); // This will be the docker container name as well as the contract folder name.

        if (create_contract(info, name, peer_port, pub_port) != 0 || run_container(name, pub_port, peer_port) != 0) // Gives 3200 if docker failed.
        {
            LOG_ERROR << errno << ": Error creating and running new hp instance for " << owner_pubkey;
            return -1;
        }

        pub_port_posfix++;
        peer_port_posfix++;

        return 0;
    }

    void kill_all_containers()
    {
        // std::string command = "docker kill -s SIGINT $(docker ps -aqf \"name=sahp\")";
        std::string command = "docker container rm -f $(docker ps -aqf \"name=-\")";
        system(command.c_str());
    }

    int run_container(const std::string &folder_name, const uint16_t pub_port, const uint16_t peer_port)
    {
        // we don't remove the container after the container stops.
        const std::string command = "docker run -t -i -d --network=hpnet --stop-signal=SIGINT --name=" + folder_name + " \
                                            -p " +
                                    std::to_string(pub_port) + ":" + std::to_string(pub_port) + " \
                                            -p " +
                                    std::to_string(peer_port) + ":" + std::to_string(peer_port) + " \
                                            --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
                                            --mount type=bind,source=" +
                                    conf::cfg.hp_instance_folder + "/" +
                                    folder_name + ",target=/contract \
                                            hpcore:latest run /contract";

        return system(command.c_str());
    }

    int stop_container(const std::string &container_name)
    {
        const std::string command = "docker stop " + container_name;
        return system(command.c_str());
    }

    int start_container(const std::string &container_name)
    {
        const std::string command = "docker start " + container_name;
        return system(command.c_str());
    }

    int remove_container(const std::string &container_name)
    {
        const std::string command = "docker container rm -f " + container_name;
        return system(command.c_str());
    }

    int create_contract(instance_info &info, const std::string &folder_name, const uint16_t peer_port, const uint16_t pub_port)
    {
        const std::string folder_path = conf::cfg.hp_instance_folder + "/" + folder_name;
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
        d["mesh"]["port"] = peer_port;
        d["user"]["port"] = pub_port;

        if (write_json_file(config_fd, d) == -1)
        {
            LOG_ERROR << "Writing modified hp config failed.";
            close(config_fd);
            return -1;
        }
        close(config_fd);

        info.ip = "localhost";
        info.contract_id = contract_id;
        info.name = folder_name;
        info.pubkey = pubkey_hex;
        info.pub_port = pub_port;
        info.peer_port = peer_port;
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
