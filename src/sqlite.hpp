#ifndef _SA_SQLITE_
#define _SA_SQLITE_

#include "pchheader.hpp"
#include "hp_manager.hpp"

namespace sqlite
{
    /**
    * Define an enum and a string array for the column data types.
    * Any column data type that needs to be supportes should be added to both the 'COLUMN_DATA_TYPE' enum and the 'column_data_type' array in its respective order.
    */
    enum COLUMN_DATA_TYPE
    {
        INT,
        TEXT,
        BLOB
    };

    /**
     * Struct of table column information.
     * {
     *  string name   Name of the column.
     *  column_type   Data type of the column.
     *  is_key        Whether column is a key.
     *  is_null       Whether column is nullable.
     * }
    */
    struct table_column_info
    {
        std::string name;
        COLUMN_DATA_TYPE column_type;
        bool is_key;
        bool is_null;

        table_column_info(std::string_view name, const COLUMN_DATA_TYPE &column_type, const bool is_key = false, const bool is_null = true)
            : name(name), column_type(column_type), is_key(is_key), is_null(is_null)
        {
        }
    };

    int open_db(std::string_view db_name, sqlite3 **db, const bool writable = false, const bool journal = true);

    int exec_sql(sqlite3 *db, std::string_view sql, int (*callback)(void *, int, char **, char **) = NULL, void *callback_first_arg = NULL);

    int begin_transaction(sqlite3 *db);

    int commit_transaction(sqlite3 *db);

    int rollback_transaction(sqlite3 *db);

    int create_table(sqlite3 *db, std::string_view table_name, const std::vector<table_column_info> &column_info);

    int create_index(sqlite3 *db, std::string_view table_name, std::string_view column_names, const bool is_unique);

    int insert_rows(sqlite3 *db, std::string_view table_name, std::string_view column_names_string, const std::vector<std::string> &value_strings);

    int insert_row(sqlite3 *db, std::string_view table_name, std::string_view column_names_string, std::string_view value_string);

    bool is_table_exists(sqlite3 *db, std::string_view table_name);

    int close_db(sqlite3 **db);

    int initialize_hp_db(sqlite3 *db);

    int insert_hp_instance_row(sqlite3 *db, const hp::instance_info &info);

    int is_container_exists(sqlite3 *db, std::string_view container_name, hp::instance_info &info);

    int update_status_in_container(sqlite3 *db, std::string_view container_name, std::string_view status);

    void get_max_ports(sqlite3 *db, hp::ports &max_ports);

    void get_vacant_ports(sqlite3 *db, std::vector<hp::ports> &vacant_ports);

    void get_running_instance_names(sqlite3 *db, std::vector<std::string> &running_instance_names);

    void get_instance_list(sqlite3 *db, std::vector<hp::instance_info> &instances);

    int get_instance(sqlite3 *db, std::string_view container_name, hp::instance_info &instance);

    int get_allocated_instance_count(sqlite3 *db);
}
#endif
