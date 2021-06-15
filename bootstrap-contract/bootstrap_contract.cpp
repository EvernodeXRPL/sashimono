#include "bootstrap_contract.hpp"

// This script will be renamed by this contract as post_exec.sh
constexpr const char *SCRIPT_NAME = "script.sh";

int main(int argc, char **argv)
{
    if (hp_init_contract() == -1)
        return 1;

    const struct hp_contract_context *ctx = hp_get_context();

    // Read and process all user inputs from the mmap.
    const void *input_mmap = hp_init_user_input_mmap();

    // Iterate through all users.
    for (int u = 0; u < ctx->users.count; u++)
    {
        const struct hp_user *user = &ctx->users.list[u];

        // Iterate through all inputs from this user.
        for (int i = 0; i < user->inputs.count; i++)
        {
            const struct hp_user_input input = user->inputs.list[i];

            // Instead of mmap, we can also read the inputs from 'ctx->users.in_fd' using file I/O.
            // However, using mmap is recommended because user inputs already reside in memory.
            const void *buf = (uint8_t *)input_mmap + input.offset;
            std::string_view buffer((char *)buf, input.size);
            try
            {
                const jsoncons::ojson d = jsoncons::bson::decode_bson<jsoncons::ojson>(buffer);
                const std::string_view file_name = d["fileName"].as<std::string_view>();
                const jsoncons::byte_string_view data = d["content"].as_byte_string_view();
                const int archive_fd = open(file_name.data(), O_CREAT | O_TRUNC | O_RDWR, 0644);

                if (open(file_name.data(), O_CREAT | O_TRUNC | O_RDWR, 0644) == -1 ||
                    write(archive_fd, data.begin(), data.size()) == -1)
                {
                    std::cerr << "Error saving given file.\n";
                    close(archive_fd);
                    return -1;
                }
                close(archive_fd);
                std::vector<uint8_t> msg;
                create_upload_success_message(msg, file_name);
                hp_write_user_msg(user, msg.data(), msg.size());
                // Rename script.sh to post_exec.sh and grant executing permissions.
                rename(SCRIPT_NAME, HP_POST_EXEC_SCRIPT_NAME);
                char mode[] = "0777";
                const mode_t permission_mode = strtol(mode, 0, 8); // Char to octal conversion.
                if (chmod(HP_POST_EXEC_SCRIPT_NAME, permission_mode) < 0)
                {
                    std::cerr << "Chmod failed for " << HP_POST_EXEC_SCRIPT_NAME << std::endl;
                    return -1;
                }
            }
            catch (const std::exception &e)
            {
                std::cerr << e.what() << '\n';
                return -1;
            }
        }
    }
    hp_deinit_user_input_mmap();
    hp_deinit_contract();
    return 0;
}

void create_upload_success_message(std::vector<uint8_t> &msg, std::string_view filename)
{
    jsoncons::bson::bson_bytes_encoder encoder(msg);
    encoder.begin_object();
    encoder.key("type");
    encoder.string_value("uploadResult");
    encoder.key("status");
    encoder.string_value("ok");
    encoder.key("fileName");
    encoder.string_value(filename);
    encoder.end_object();
    encoder.flush();
}
