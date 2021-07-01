#include "../pchheader.hpp"
#include "util.hpp"

namespace util
{
    constexpr mode_t DIR_PERMS = 0755;

    const std::string to_hex(const std::string_view bin)
    {
        // Allocate the target string.
        std::string encoded_string;
        encoded_string.resize(bin.size() * 2);

        // Get encoded string.
        sodium_bin2hex(
            encoded_string.data(),
            encoded_string.length() + 1, // + 1 because sodium writes ending '\0' character as well.
            reinterpret_cast<const unsigned char *>(bin.data()),
            bin.size());
        return encoded_string;
    }

    const std::string to_bin(const std::string_view hex)
    {
        std::string bin;
        bin.resize(hex.size() / 2);

        const char *hex_end;
        size_t bin_len;
        if (sodium_hex2bin(
                reinterpret_cast<unsigned char *>(bin.data()), bin.size(),
                hex.data(), hex.size(),
                "", &bin_len, &hex_end))
        {
            return ""; // Empty indicates error.
        }

        return bin;
    }

    /**
     * Check whether given directory exists. 
     * @param path Directory path.
     * @return Returns true if given directory exists otherwise false.
     */
    bool is_dir_exists(std::string_view path)
    {
        struct stat st;
        return (stat(path.data(), &st) == 0 && S_ISDIR(st.st_mode));
    }

    /**
     * Check whether given file exists. 
     * @param path File path.
     * @return Returns true if give file exists otherwise false.
     */
    bool is_file_exists(std::string_view path)
    {
        struct stat st;
        return (stat(path.data(), &st) == 0 && S_ISREG(st.st_mode));
    }

    /**
     * Recursively creates directories and sub-directories if not exist. 
     * @param path Directory path.
     * @return Returns 0 operations succeeded otherwise -1.
     */
    int create_dir_tree_recursive(std::string_view path)
    {
        if (strcmp(path.data(), "/") == 0) // No need of checking if we are at root.
            return 0;

        // Check whether this dir exists or not.
        struct stat st;
        if (stat(path.data(), &st) != 0 || !S_ISDIR(st.st_mode))
        {
            // Check and create parent dir tree first.
            char *path2 = strdup(path.data());
            char *parent_dir_path = dirname(path2);
            bool error_thrown = false;

            if (create_dir_tree_recursive(parent_dir_path) == -1)
                error_thrown = true;

            free(path2);

            // Create this dir.
            if (!error_thrown && mkdir(path.data(), DIR_PERMS) == -1)
            {
                std::cerr << errno << ": Error in recursive dir creation. " << path << std::endl;
                error_thrown = true;
            }

            if (error_thrown)
                return -1;
        }

        return 0;
    }

    /**
     * Reads the entire file from given file discriptor. 
     * @param fd File descriptor to be read.
     * @param buf String buffer to be populated.
     * @param offset Begin offset of the file to read.
     * @return Returns number of bytes read in a successful read and -1 on error.
    */
    int read_from_fd(const int fd, std::string &buf, const off_t offset)
    {
        struct stat st;
        if (fstat(fd, &st) == -1)
        {
            std::cerr << errno << ": Error in stat for reading entire file." << std::endl;
            return -1;
        }

        buf.resize(st.st_size - offset);

        return pread(fd, buf.data(), buf.size(), offset);
    }

    /**
     * Provide a safe std::string overload for realpath.
     * @param path Path.
     * @returns Returns the realpath as string.
    */
    const std::string realpath(std::string_view path)
    {
        std::array<char, PATH_MAX> buffer;
        ::realpath(path.data(), buffer.data());
        buffer[PATH_MAX] = '\0';
        return buffer.data();
    }

    /**
     * Clears signal mask and signal handlers from the caller.
     * Called by other processes forked from sagent threads so they get detatched from
     * the sagent signal setup.
     */
    void fork_detach()
    {
        // Restore signal handlers to defaults.
        signal(SIGINT, SIG_DFL);
        signal(SIGSEGV, SIG_DFL);
        signal(SIGABRT, SIG_DFL);

        // Remove any signal masks applied by sagent.
        sigset_t mask;
        sigemptyset(&mask);
        pthread_sigmask(SIG_SETMASK, &mask, NULL);

        // Set process group id (so the terminal doesn't send kill signals to forked children).
        setpgrp();
    }

    // Applies signal mask to the calling thread.
    void mask_signal()
    {
        sigset_t mask;
        sigemptyset(&mask);
        sigaddset(&mask, SIGINT);
        sigaddset(&mask, SIGPIPE);
        pthread_sigmask(SIG_BLOCK, &mask, NULL);
    }

    /**
     * Sleeps the current thread for specified no. of milliseconds.
     */
    void sleep(const uint64_t milliseconds)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    }

    /**
    * Returns current time in UNIX epoch milliseconds.
    */
    uint64_t get_epoch_milliseconds()
    {
        return std::chrono::duration_cast<std::chrono::duration<std::uint64_t, std::milli>>(
                   std::chrono::system_clock::now().time_since_epoch())
            .count();
    }

    /**
     * Remove a directory recursively with it's content. FTW_DEPTH is provided so all of the files and subdirectories within
     * The path will be processed. FTW_PHYS is provided so symbolic links won't be followed.
     */
    int remove_directory_recursively(std::string_view dir_path)
    {
        return nftw(
            dir_path.data(), [](const char *fpath, const struct stat *sb, int typeflag, struct FTW *ftwbuf)
            { return remove(fpath); },
            1, FTW_DEPTH | FTW_PHYS);
    }

    // Kill a process with a signal and if specified, wait until it stops running.
    int kill_process(const pid_t pid, const bool wait, const int signal)
    {
        if (kill(pid, signal) == -1)
        {
            LOG_ERROR << errno << ": Error issuing signal to pid " << pid;
            return -1;
        }

        const int wait_options = wait ? 0 : WNOHANG;
        if (waitpid(pid, NULL, wait_options) == -1)
        {
            LOG_ERROR << errno << ": waitpid after kill (pid:" << pid << ") failed.";
            return -1;
        }

        return 0;
    }

    /**
     * Split string by given delimeter.
     * @param collection Splitted strings params.
     * @param delimeter Delimeter to split string.
    */
    void split_string(std::vector<std::string> &collection, std::string_view str, std::string_view delimeter)
    {
        if (str.empty())
            return;

        size_t start = 0;
        size_t end = str.find(delimeter);

        while (end != std::string::npos)
        {
            // Do not add empty strings.
            if (start != end)
                collection.push_back(std::string(str.substr(start, end - start)));
            start = end + delimeter.length();
            end = str.find(delimeter, start);
        }

        // If there are any leftover from the source string add the remaining.
        if (start < str.size())
            collection.push_back(std::string(str.substr(start)));
    }

    /**
     * Converts given string to a int. A wrapper function for std::stoi. 
     * @param str String variable.
     * @param result Variable to store the answer from the conversion.
     * @return Returns 0 in a successful conversion and -1 on error.
    */
    int stoi(const std::string &str, int &result)
    {
        try
        {
            result = std::stoi(str);
        }
        catch (const std::exception &e)
        {
            // Return -1 if any exceptions are captured.
            return -1;
        }
        return 0;
    }

    /**
     * Converts given string to a uint16_t. A wrapper function for std::stoul. 
     * @param str String variable.
     * @param result Variable to store the answer from the conversion.
     * @return Returns 0 in a successful conversion and -1 on error.
    */
    int stoul(const std::string &str, uint16_t &result)
    {
        try
        {
            result = std::stoul(str);
        }
        catch (const std::exception &e)
        {
            // Return -1 if any exceptions are captured.
            return -1;
        }
        return 0;
    }

    /**
     * Construct the user contract directory path when username is given.
     * @param username Username of the user.
     * @return Contract directory path.
    */
    const std::string get_user_contract_dir(const std::string &username, std::string_view container_name)
    {
        return "/home/" + username + "/" + container_name.data();
    }

    /**
     * Get system user info by given user name.
     * @param username Username of the user.
     * @param user_info User info struct to be populated.
     * @return -1 of error, 0 on success.
    */
    int get_system_user_info(std::string_view username, user_info &user_info)
    {
        const struct passwd *pwd = getpwnam(username.data());

        if (pwd == NULL)
        {
            LOG_ERROR << errno << ": Error in getpwnam " << username;
            return -1;
        }

        user_info.username = username;
        user_info.user_id = pwd->pw_uid;
        user_info.group_id = pwd->pw_gid;
        user_info.home_dir = pwd->pw_dir;
        return 0;
    }

    /**
     * Find and replace given substring inside a string.
     * @param str String to be modified.
     * @param find Substring to be searched.
     * @param replace Substring to be replaced.
    */
    void find_and_replace(std::string &str, std::string_view find, std::string_view replace)
    {
        size_t pos = str.find(find);
        while (pos != std::string::npos)
        {
            str.replace(pos, find.length(), replace);
            pos = str.find(find);
        }
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
     * Reads the given file to a json doc.
     * @param fd File descriptor to the open file.
     * @param d JSON document to be populated.
     * @return 0 on success. -1 on failure.
     */
    int read_json_file(const int fd, jsoncons::ojson &d)
    {
        std::string buf;
        if (util::read_from_fd(fd, buf) == -1)
        {
            std::cerr << "Error reading from the config file. " << errno << '\n';
            return -1;
        }

        try
        {
            d = jsoncons::ojson::parse(buf, jsoncons::strict_json_parsing());
        }
        catch (const std::exception &e)
        {
            std::cerr << "Invalid config file format. " << e.what() << '\n';
            return -1;
        }
        buf.clear();

        return 0;
    }

} // namespace util
