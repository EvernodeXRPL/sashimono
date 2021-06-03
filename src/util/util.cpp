#include "../pchheader.hpp"
#include "util.hpp"

namespace util
{
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
            if (!error_thrown && mkdir(path.data(), S_IRWXU | S_IRWXG | S_IROTH) == -1)
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

} // namespace util
