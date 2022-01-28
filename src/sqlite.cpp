#include "sqlite.hpp"
#include "salog.hpp"
#include "util/util.hpp"
#include "conf.hpp"

namespace sqlite
{
    constexpr const char *COLUMN_DATA_TYPES[]{"INT", "TEXT", "BLOB"};
    constexpr const char *CREATE_TABLE = "CREATE TABLE IF NOT EXISTS ";
    constexpr const char *CREATE_INDEX = "CREATE INDEX ";
    constexpr const char *CREATE_UNIQUE_INDEX = "CREATE UNIQUE INDEX ";
    constexpr const char *JOURNAL_MODE_OFF = "PRAGMA journal_mode=OFF";
    constexpr const char *BEGIN_TRANSACTION = "BEGIN TRANSACTION;";
    constexpr const char *COMMIT_TRANSACTION = "COMMIT;";
    constexpr const char *ROLLBACK_TRANSACTION = "ROLLBACK;";
    constexpr const char *INSERT_INTO = "INSERT INTO ";
    constexpr const char *PRIMARY_KEY = "PRIMARY KEY";
    constexpr const char *NOT_NULL = "NOT NULL";
    constexpr const char *VALUES = "VALUES";

    constexpr const char *INSTANCE_TABLE = "instances";

    constexpr const char *INSERT_INTO_HP_INSTANCE = "INSERT INTO instances("
                                                    "owner_pubkey, time, username, status, name, ip,"
                                                    "peer_port, user_port, pubkey, contract_id, image_name"
                                                    ") VALUES(?,?,?,?,?,?,?,?,?,?,?)";

    constexpr const char *GET_VACANT_PORTS_FROM_HP = "SELECT DISTINCT peer_port, user_port FROM "
                                                     "instances WHERE status == ? AND user_port NOT IN"
                                                     "(SELECT user_port FROM instances WHERE status != ?)";

    constexpr const char *GET_MAX_PORTS_FROM_HP = "SELECT max(peer_port), max(user_port) FROM instances WHERE status != ?";

    constexpr const char *UPDATE_STATUS_IN_HP = "UPDATE instances SET status = ? WHERE name = ?";

    constexpr const char *IS_CONTAINER_EXISTS = "SELECT username, status, peer_port, user_port FROM instances WHERE name = ?";

    constexpr const char *GET_ALOCATED_INSTANCE_COUNT = "SELECT COUNT(name) FROM instances WHERE status != ?";

    constexpr const char *GET_RUNNING_INSTANCE_NAMES = "SELECT name FROM instances WHERE status = ?";

    constexpr const char *GET_INSTANCE_LIST = "SELECT name, username, user_port, peer_port, status, image_name FROM instances WHERE status != ?";

    constexpr const char *GET_INSTANCE = "SELECT name, username, user_port, peer_port, status, image_name FROM instances WHERE name == ? AND status != ?";

    constexpr const char *IS_TABLE_EXISTS = "SELECT * FROM sqlite_master WHERE type='table' AND name = ?";

    /**
     * Opens a connection to a given databse and give the db pointer.
     * @param db_name Database name to be connected.
     * @param db Pointer to the db pointer which is to be connected and pointed.
     * @param writable Whether the database must be opened in a writable mode or not.
     * @param journal Whether to enable db journaling or not.
     * @returns returns 0 on success, or -1 on error.
    */
    int open_db(std::string_view db_name, sqlite3 **db, const bool writable, const bool journal)
    {
        int ret;
        const int flags = writable ? (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) : SQLITE_OPEN_READONLY;
        if ((ret = sqlite3_open_v2(db_name.data(), db, flags, 0)) != SQLITE_OK)
        {
            LOG_ERROR << ret << ": Sqlite error when opening database " << db_name;
            *db = NULL;
            return -1;
        }

        // We can turn off journaling for the db if we don't need transacion support.
        // Journaling mode can introduce lot of extra underyling file system operations which may cause
        // lot of overhead if used on a low-performance filesystem like hpfs.
        if (writable && !journal && exec_sql(*db, JOURNAL_MODE_OFF) == -1)
            return -1;

        return 0;
    }

    /**
     * Executes given sql query.
     * @param db Pointer to the db.
     * @param sql Sql query to be executed.
     * @param callback Callback funcion which is called for each result row.
     * @param callback_first_arg First data argumat to be parced to the callback (void pointer).
     * @returns returns 0 on success, or -1 on error.
    */
    int exec_sql(sqlite3 *db, std::string_view sql, int (*callback)(void *, int, char **, char **), void *callback_first_arg)
    {
        char *err_msg;
        if (sqlite3_exec(db, sql.data(), callback, (callback != NULL ? (void *)callback_first_arg : NULL), &err_msg) != SQLITE_OK)
        {
            LOG_ERROR << "SQL error occured: " << err_msg;
            sqlite3_free(err_msg);
            return -1;
        }
        return 0;
    }

    int begin_transaction(sqlite3 *db)
    {
        return sqlite::exec_sql(db, BEGIN_TRANSACTION);
    }

    int commit_transaction(sqlite3 *db)
    {
        return sqlite::exec_sql(db, COMMIT_TRANSACTION);
    }

    int rollback_transaction(sqlite3 *db)
    {
        return sqlite::exec_sql(db, ROLLBACK_TRANSACTION);
    }

    /**
     * Create a table with given table info.
     * @param db Pointer to the db.
     * @param table_name Table name to be created.
     * @param column_info Column info of the table.
     * @returns returns 0 on success, or -1 on error.
    */
    int create_table(sqlite3 *db, std::string_view table_name, const std::vector<table_column_info> &column_info)
    {
        std::string sql;
        sql.append(CREATE_TABLE).append(table_name).append(" (");

        for (auto itr = column_info.begin(); itr != column_info.end(); ++itr)
        {
            sql.append(itr->name);
            sql.append(" ");
            sql.append(COLUMN_DATA_TYPES[itr->column_type]);

            if (itr->is_key)
            {
                sql.append(" ");
                sql.append(PRIMARY_KEY);
            }

            if (!itr->is_null)
            {
                sql.append(" ");
                sql.append(NOT_NULL);
            }

            if (itr != column_info.end() - 1)
                sql.append(",");
        }
        sql.append(")");

        const int ret = exec_sql(db, sql);
        if (ret == -1)
        {
            LOG_ERROR << "Error when creating sqlite table " << table_name;
        }

        return ret;
    }

    int create_index(sqlite3 *db, std::string_view table_name, std::string_view column_names, const bool is_unique)
    {
        std::string index_name = std::string("idx_").append(table_name).append("_").append(column_names);
        std::replace(index_name.begin(), index_name.end(), ',', '_');

        std::string sql;
        sql.append(is_unique ? CREATE_UNIQUE_INDEX : CREATE_INDEX)
            .append(index_name)
            .append(" ON ")
            .append(table_name)
            .append("(")
            .append(column_names)
            .append(")");

        const int ret = exec_sql(db, sql);
        if (ret == -1)
        {
            LOG_ERROR << "Error when creating sqlite index '" << index_name << "' in table " << table_name;
        }

        return ret;
    }

    /**
     * Inserts mulitple rows to a table.
     * @param db Pointer to the db.
     * @param table_name Table name to be populated.
     * @param column_names_string Comma seperated string of colums (eg: "col_1,col_2,...").
     * @param value_strings Vector of comma seperated values (wrap in single quotes for TEXT type) (eg: ["r1val1,'r1val2',...", "r2val1,'r2val2',..."]).
     * @returns returns 0 on success, or -1 on error.
    */
    int insert_rows(sqlite3 *db, std::string_view table_name, std::string_view column_names_string, const std::vector<std::string> &value_strings)
    {
        std::string sql;

        sql.append(INSERT_INTO);
        sql.append(table_name);
        sql.append("(");
        sql.append(column_names_string);
        sql.append(") ");
        sql.append(VALUES);

        for (auto itr = value_strings.begin(); itr != value_strings.end(); ++itr)
        {
            sql.append("(");
            sql.append(*itr);
            sql.append(")");

            if (itr != value_strings.end() - 1)
                sql.append(",");
        }

        /* Execute SQL statement */
        return exec_sql(db, sql);
    }

    /**
     * Inserts a row to a table.
     * @param db Pointer to the db.
     * @param table_name Table name to be populated.
     * @param column_names_string Comma seperated string of colums (eg: "col_1,col_2,...").
     * @param value_string comma seperated values as per column order (wrap in single quotes for TEXT type) (eg: "r1val1,'r1val2',...").
     * @returns returns 0 on success, or -1 on error.
    */
    int insert_row(sqlite3 *db, std::string_view table_name, std::string_view column_names_string, std::string_view value_string)
    {
        std::string sql;
        // Reserving the space for the query before construction.
        sql.reserve(sizeof(INSERT_INTO) + table_name.size() + column_names_string.size() + sizeof(VALUES) + value_string.size() + 5);

        sql.append(INSERT_INTO);
        sql.append(table_name);
        sql.append("(");
        sql.append(column_names_string);
        sql.append(") ");
        sql.append(VALUES);
        sql.append("(");
        sql.append(value_string);
        sql.append(")");

        /* Execute SQL statement */
        return exec_sql(db, sql);
    }

    /**
     * Checks whether table exist in the database.
     * @param db Pointer to the db.
     * @param table_name Table name to be checked.
     * @returns returns true is exist, otherwise false.
    */
    bool is_table_exists(sqlite3 *db, std::string_view table_name)
    {
        sqlite3_stmt *stmt;

        if (sqlite3_prepare_v2(db, IS_TABLE_EXISTS, -1, &stmt, 0) == SQLITE_OK &&
            stmt != NULL && sqlite3_bind_text(stmt, 1, table_name.data(), table_name.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_step(stmt) == SQLITE_ROW)
        {
            // Finalize and distroys the statement.
            sqlite3_finalize(stmt);
            return true;
        }

        // Finalize and distroys the statement.
        sqlite3_finalize(stmt);
        return false;
    }

    /**
     * Closes a connection to a given databse.
     * @param db Pointer to the db.
     * @returns returns 0 on success, or -1 on error.
    */
    int close_db(sqlite3 **db)
    {
        if (*db == NULL)
            return 0;

        if (sqlite3_close(*db) != SQLITE_OK)
        {
            LOG_ERROR << "Can't close database: " << sqlite3_errmsg(*db);
            return -1;
        }

        *db = NULL;
        return 0;
    }

    /**
     * Initialize hp_instances table. Table is only created if not existed. Indexes are added for name and owner_pubkey fields.
     * @param db Database connection.
     * @return -1 on error and 0 on success.
    */
    int initialize_hp_db(sqlite3 *db)
    {
        if (!is_table_exists(db, INSTANCE_TABLE))
        {
            const std::vector<table_column_info> columns{
                table_column_info("owner_pubkey", COLUMN_DATA_TYPE::TEXT),
                table_column_info("time", COLUMN_DATA_TYPE::INT),
                table_column_info("username", COLUMN_DATA_TYPE::TEXT),
                table_column_info("status", COLUMN_DATA_TYPE::TEXT),
                table_column_info("name", COLUMN_DATA_TYPE::TEXT, true),
                table_column_info("ip", COLUMN_DATA_TYPE::TEXT),
                table_column_info("peer_port", COLUMN_DATA_TYPE::INT),
                table_column_info("user_port", COLUMN_DATA_TYPE::INT),
                table_column_info("pubkey", COLUMN_DATA_TYPE::TEXT),
                table_column_info("contract_id", COLUMN_DATA_TYPE::TEXT),
                table_column_info("image_name", COLUMN_DATA_TYPE::TEXT)};

            if (create_table(db, INSTANCE_TABLE, columns) == -1 ||
                create_index(db, INSTANCE_TABLE, "name", true) == -1 ||
                create_index(db, INSTANCE_TABLE, "owner_pubkey", false) == -1) // one user can have multiple instances running.
                return -1;
        }
        return 0;
    }

    /**
     * Inserts a hp instance record.
     * @param db Pointer to the db.
     * @param info HP instance information.
     * @returns returns 0 on success, or -1 on error.
    */
    int insert_hp_instance_row(sqlite3 *db, const hp::instance_info &info)
    {
        sqlite3_stmt *stmt;
        if (sqlite3_prepare_v2(db, INSERT_INTO_HP_INSTANCE, -1, &stmt, 0) == SQLITE_OK && stmt != NULL &&
            sqlite3_bind_text(stmt, 1, info.owner_pubkey.data(), info.owner_pubkey.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_int64(stmt, 2, util::get_epoch_milliseconds()) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 3, info.username.data(), info.username.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 4, info.status.data(), info.status.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 5, info.container_name.data(), info.container_name.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 6, info.ip.data(), info.ip.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_int64(stmt, 7, info.assigned_ports.peer_port) == SQLITE_OK &&
            sqlite3_bind_int64(stmt, 8, info.assigned_ports.user_port) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 9, info.pubkey.data(), info.pubkey.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 10, info.contract_id.data(), info.contract_id.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 11, info.image_name.data(), info.image_name.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_step(stmt) == SQLITE_DONE)
        {
            sqlite3_finalize(stmt);
            return 0;
        }

        LOG_ERROR << errno << ": Error inserting hp instance record. " << sqlite3_errmsg(db);
        return -1;
    }

    /**
     * Checks whether the container exist in the database and populate the instance information.
     * @param db Pointer to the db.
     * @param container_name Name of the container to be checked.
     * @param info HP instance information.
     * @returns 0 if not found, 1 if container exists .
    */
    int is_container_exists(sqlite3 *db, std::string_view container_name, hp::instance_info &info)
    {
        sqlite3_stmt *stmt;

        if (sqlite3_prepare_v2(db, IS_CONTAINER_EXISTS, -1, &stmt, 0) == SQLITE_OK &&
            stmt != NULL && sqlite3_bind_text(stmt, 1, container_name.data(), container_name.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_step(stmt) == SQLITE_ROW)
        {
            // Populate only the necessary fields.
            info.username = std::string(reinterpret_cast<const char *>(sqlite3_column_text(stmt, 0)));
            info.status = std::string(reinterpret_cast<const char *>(sqlite3_column_text(stmt, 1)));
            info.assigned_ports.peer_port = sqlite3_column_int64(stmt, 2);
            info.assigned_ports.user_port = sqlite3_column_int64(stmt, 3);

            // Finalize and distroys the statement.
            sqlite3_finalize(stmt);
            return 1;
        }

        // Finalize and distroys the statement.
        sqlite3_finalize(stmt);
        return 0; // Not found
    }

    /**
     * Update the status of the given container to the new value.
     * @param db Database connection.
     * @param container_name Name of the container whose status should be updated.
     * @param status The new status of the container.
     * @return 0 on success and -1 on error. 
    */
    int update_status_in_container(sqlite3 *db, std::string_view container_name, std::string_view status)
    {
        sqlite3_stmt *stmt;
        if (sqlite3_prepare_v2(db, UPDATE_STATUS_IN_HP, -1, &stmt, 0) == SQLITE_OK && stmt != NULL &&
            sqlite3_bind_text(stmt, 1, status.data(), status.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 2, container_name.data(), container_name.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_step(stmt) == SQLITE_DONE)
        {
            sqlite3_finalize(stmt);
            return 0;
        }
        LOG_ERROR << "Error updating container status for " << container_name;
        return -1;
    }

    /**
     * Get the max peer and user ports assigned for instances excluding destroyed instances.
     * @param db Database connection.
     * @param max_ports Container holding max peer and user ports.
    */
    void get_max_ports(sqlite3 *db, hp::ports &max_ports)
    {
        sqlite3_stmt *stmt;

        if (sqlite3_prepare_v2(db, GET_MAX_PORTS_FROM_HP, -1, &stmt, 0) == SQLITE_OK && stmt != NULL &&
            sqlite3_bind_text(stmt, 1, hp::CONTAINER_STATES[hp::STATES::DESTROYED], sizeof(hp::CONTAINER_STATES[hp::STATES::DESTROYED]), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_step(stmt) == SQLITE_ROW)
        {
            const uint16_t peer_port = sqlite3_column_int64(stmt, 0);
            const uint16_t user_port = sqlite3_column_int64(stmt, 1);

            max_ports = {peer_port, user_port};
        }
        // Initialize with default config values if either of the ports are zero.
        if (max_ports.peer_port == 0 || max_ports.user_port == 0)
        {
            max_ports = {(uint16_t)(conf::cfg.hp.init_peer_port - 1), (uint16_t)(conf::cfg.hp.init_user_port - 1)};
        }

        // Finalize and distroys the statement.
        sqlite3_finalize(stmt);
    }

    /**
     * Populate the given vector with vacant ports of destroyed instances which are not already assigned.
     * @param db Database connection.
     * @param vacant_ports Ports vector to hold port pairs from database.
    */
    void get_vacant_ports(sqlite3 *db, std::vector<hp::ports> &vacant_ports)
    {

        sqlite3_stmt *stmt;
        std::string_view destroy_status(hp::CONTAINER_STATES[hp::STATES::DESTROYED]);

        if (sqlite3_prepare_v2(db, GET_VACANT_PORTS_FROM_HP, -1, &stmt, 0) == SQLITE_OK && stmt != NULL &&
            sqlite3_bind_text(stmt, 1, destroy_status.data(), destroy_status.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 2, destroy_status.data(), destroy_status.length(), SQLITE_STATIC) == SQLITE_OK)
        {
            while (stmt != NULL && sqlite3_step(stmt) == SQLITE_ROW)
            {
                const uint16_t peer_port = sqlite3_column_int64(stmt, 0);
                const uint16_t user_port = sqlite3_column_int64(stmt, 1);
                vacant_ports.push_back({peer_port, user_port});
            }
        }

        // Finalize and distroys the statement.
        sqlite3_finalize(stmt);
    }

    /**
     * Populate the given vector with names of running hp instances.
     * @param db Database connection.
     * @param running_instance_names Vector to hold name of instances from database.
    */
    void get_running_instance_names(sqlite3 *db, std::vector<std::string> &running_instance_names)
    {
        running_instance_names.clear();

        sqlite3_stmt *stmt;
        std::string_view running_status(hp::CONTAINER_STATES[hp::STATES::RUNNING]);

        if (sqlite3_prepare_v2(db, GET_RUNNING_INSTANCE_NAMES, -1, &stmt, 0) == SQLITE_OK && stmt != NULL &&
            sqlite3_bind_text(stmt, 1, running_status.data(), running_status.length(), SQLITE_STATIC) == SQLITE_OK)
        {
            while (stmt != NULL && sqlite3_step(stmt) == SQLITE_ROW)
            {
                const std::string name(reinterpret_cast<const char *>(sqlite3_column_text(stmt, 0)));
                running_instance_names.push_back(name);
            }
        }

        // Finalize and distroys the statement.
        sqlite3_finalize(stmt);
    }

    /**
     * Populate the given vector with the instance list except destroyed instances.
     * @param db Database connection.
     * @param running_instances Vector to hold instance details.
    */
    void get_instance_list(sqlite3 *db, std::vector<hp::instance_info> &instances)
    {
        sqlite3_stmt *stmt;
        std::string_view destroy_status(hp::CONTAINER_STATES[hp::STATES::DESTROYED]);

        if (sqlite3_prepare_v2(db, GET_INSTANCE_LIST, -1, &stmt, 0) == SQLITE_OK && stmt != NULL &&
            sqlite3_bind_text(stmt, 1, destroy_status.data(), destroy_status.length(), SQLITE_STATIC) == SQLITE_OK)
        {
            while (stmt != NULL && sqlite3_step(stmt) == SQLITE_ROW)
            {
                hp::instance_info info;
                info.container_name = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 0));
                info.username = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 1));
                info.assigned_ports.user_port = sqlite3_column_int64(stmt, 2);
                info.assigned_ports.peer_port = sqlite3_column_int64(stmt, 3);
                info.status = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 4));
                info.image_name = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 5));
                instances.push_back(info);
            }
        }

        // Finalize and distroys the statement.
        sqlite3_finalize(stmt);
    }

    /**
     * Populate the given instace ref with the container info of given name only if not destroyed.
     * @param db Database connection.
     * @param container_name Container name.
     * @param instance Instance details.
     * @return 0 on if exist otherwise -1.
    */
    int get_instance(sqlite3 *db, std::string_view container_name, hp::instance_info &instance)
    {
        sqlite3_stmt *stmt;
        std::string_view destroy_status(hp::CONTAINER_STATES[hp::STATES::DESTROYED]);

        if (sqlite3_prepare_v2(db, GET_INSTANCE, -1, &stmt, 0) == SQLITE_OK && stmt != NULL &&
            sqlite3_bind_text(stmt, 1, container_name.data(), container_name.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 2, destroy_status.data(), destroy_status.length(), SQLITE_STATIC) == SQLITE_OK &&
            (stmt != NULL && sqlite3_step(stmt) == SQLITE_ROW))
        {
            instance.container_name = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 0));
            instance.username = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 1));
            instance.assigned_ports.user_port = sqlite3_column_int64(stmt, 2);
            instance.assigned_ports.peer_port = sqlite3_column_int64(stmt, 3);
            instance.status = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 4));
            instance.image_name = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 5));

            // Finalize and distroys the statement.
            sqlite3_finalize(stmt);
            return 0;
        }

        // Finalize and distroys the statement.
        sqlite3_finalize(stmt);
        return -1;
    }

    /**
     * Get count of running instances
     * @param db Database connection.
     * @return Count on success -1 on error.
    */
    int get_allocated_instance_count(sqlite3 *db)
    {
        sqlite3_stmt *stmt;
        std::string_view destroyed_status(hp::CONTAINER_STATES[hp::STATES::DESTROYED]);

        if (sqlite3_prepare_v2(db, GET_ALOCATED_INSTANCE_COUNT, -1, &stmt, 0) == SQLITE_OK && stmt != NULL &&
            sqlite3_bind_text(stmt, 1, destroyed_status.data(), destroyed_status.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_step(stmt) == SQLITE_ROW)
        {
            const uint64_t count = sqlite3_column_int64(stmt, 0);
            // Finalize and distroys the statement.
            sqlite3_finalize(stmt);
            return count;
        }

        // Finalize and distroys the statement.
        sqlite3_finalize(stmt);
        return -1;
    }
}
