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
    constexpr const char *SELECT_ALL = "SELECT * FROM ";
    constexpr const char *SQLITE_MASTER = "sqlite_master";
    constexpr const char *WHERE = " WHERE ";
    constexpr const char *AND = " AND ";
    constexpr const char *SELECT_DISTINCT = "SELECT DISTINCT ";
    constexpr const char *SELECT = "SELECT ";
    constexpr const char *FROM = " FROM ";
    constexpr const char *NOT_IN = " NOT IN (";

    constexpr const char *INSTANCE_TABLE = "instances";
    constexpr const char *PEER_PORT = "peer_port";
    constexpr const char *USER_PORT = "user_port";

    constexpr const char *INSERT_INTO_HP_INSTANCE = "INSERT INTO instances("
                                                    "owner_pubkey, time, status, name, ip,"
                                                    "peer_port, user_port, pubkey, contract_id"
                                                    ") VALUES(?,?,?,?,?,?,?,?,?)";

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
            LOG_ERROR << "Error when creating sqlite table " << table_name;

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
            LOG_ERROR << "Error when creating sqlite index '" << index_name << "' in table " << table_name;

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
        std::string sql;
        // Reserving the space for the query before construction.
        sql.reserve(sizeof(SELECT_ALL) + sizeof(SQLITE_MASTER) + sizeof(WHERE) + sizeof(AND) + table_name.size() + 19);

        sql.append(SELECT_ALL);
        sql.append(SQLITE_MASTER);
        sql.append(WHERE);
        sql.append("type='table'");
        sql.append(AND);
        sql.append("name='");
        sql.append(table_name);
        sql.append("'");

        sqlite3_stmt *stmt;

        if (sqlite3_prepare_v2(db, sql.data(), -1, &stmt, 0) == SQLITE_OK &&
            stmt != NULL && sqlite3_step(stmt) == SQLITE_ROW)
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
                table_column_info("status", COLUMN_DATA_TYPE::TEXT),
                table_column_info("name", COLUMN_DATA_TYPE::TEXT, true),
                table_column_info("ip", COLUMN_DATA_TYPE::TEXT),
                table_column_info(PEER_PORT, COLUMN_DATA_TYPE::INT),
                table_column_info(USER_PORT, COLUMN_DATA_TYPE::INT),
                table_column_info("pubkey", COLUMN_DATA_TYPE::TEXT),
                table_column_info("contract_id", COLUMN_DATA_TYPE::TEXT)};

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
            sqlite3_bind_text(stmt, 3, info.status.data(), info.status.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 4, info.name.data(), info.name.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 5, info.ip.data(), info.ip.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_int64(stmt, 6, info.assigned_ports.peer_port) == SQLITE_OK &&
            sqlite3_bind_int64(stmt, 7, info.assigned_ports.user_port) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 8, info.pubkey.data(), info.pubkey.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_bind_text(stmt, 9, info.contract_id.data(), info.contract_id.length(), SQLITE_STATIC) == SQLITE_OK &&
            sqlite3_step(stmt) == SQLITE_DONE)
        {
            sqlite3_finalize(stmt);
            return 0;
        }

        LOG_ERROR << "Error inserting hp instance record. " << sqlite3_errmsg(db);
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
        std::string sql;
        // Reserving the space for the query before construction.
        sql.reserve(sizeof(SELECT_ALL) + sizeof(SQLITE_MASTER) + sizeof(WHERE) + sizeof(AND) + container_name.size() + 7);

        sql.append(SELECT_ALL);
        sql.append(INSTANCE_TABLE);
        sql.append(WHERE);
        sql.append("name='");
        sql.append(container_name);
        sql.append("'");

        sqlite3_stmt *stmt;

        if (sqlite3_prepare_v2(db, sql.data(), -1, &stmt, 0) == SQLITE_OK &&
            stmt != NULL && sqlite3_step(stmt) == SQLITE_ROW)
        {
            // Populate only the necessary fields.
            info.status = std::string(reinterpret_cast<const char *>(sqlite3_column_text(stmt, 2)));
            info.assigned_ports.peer_port = sqlite3_column_int64(stmt, 5);
            info.assigned_ports.user_port = sqlite3_column_int64(stmt, 6);
            
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
        std::string sql;
        // Reserving the space for the query before construction.
        sql.reserve(sizeof(INSTANCE_TABLE) + status.length() + sizeof(WHERE) + container_name.size() + 30);
        sql.append("UPDATE ");
        sql.append(INSTANCE_TABLE);
        sql.append(" SET status = '");
        sql.append(status);
        sql.append("'");
        sql.append(WHERE);
        sql.append("name='");
        sql.append(container_name);
        sql.append("'");

        return sqlite::exec_sql(db, sql);
    }

    /**
     * Get the max peer and user ports assigned for instances excluding destroyed instances.
     * @param db Database connection.
     * @param max_ports Container holding max peer and user ports.
    */
    void get_max_ports(sqlite3 *db, hp::ports &max_ports)
    {
        std::string sql;
        // Reserving the space for the query before construction.
        sql.reserve(sizeof(INSTANCE_TABLE) + sizeof(PEER_PORT) + sizeof(USER_PORT) + sizeof(WHERE) + sizeof(hp::CONTAINER_STATES[hp::STATES::DESTROYED]) + 36);
        sql.append("SELECT max(")
            .append(PEER_PORT)
            .append("), max(")
            .append(USER_PORT)
            .append(") from ")
            .append(INSTANCE_TABLE)
            .append(WHERE)
            .append("status !='")
            .append(hp::CONTAINER_STATES[hp::STATES::DESTROYED])
            .append("'");

        sqlite3_stmt *stmt;

        if (sqlite3_prepare_v2(db, sql.data(), -1, &stmt, 0) == SQLITE_OK &&
            stmt != NULL && sqlite3_step(stmt) == SQLITE_ROW)
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
        std::string sql;
        sql.reserve(sizeof(SELECT_DISTINCT) + sizeof(PEER_PORT) + 3 * sizeof(USER_PORT) + 2 * sizeof(FROM) +
                    2 * sizeof(INSTANCE_TABLE) + 2 * sizeof(WHERE) + 2 * sizeof(hp::CONTAINER_STATES[hp::STATES::DESTROYED]) +
                    sizeof(AND) + sizeof(NOT_IN) + sizeof(SELECT) + 27);

        sql.append(SELECT_DISTINCT)
            .append(PEER_PORT)
            .append(", ")
            .append(USER_PORT)
            .append(FROM)
            .append(INSTANCE_TABLE)
            .append(WHERE)
            .append("status == '")
            .append(hp::CONTAINER_STATES[hp::STATES::DESTROYED])
            .append("'")
            .append(AND)
            .append(USER_PORT)
            .append(NOT_IN)
            .append(SELECT)
            .append(USER_PORT)
            .append(FROM)
            .append(INSTANCE_TABLE)
            .append(WHERE)
            .append("status != '")
            .append(hp::CONTAINER_STATES[hp::STATES::DESTROYED])
            .append("')");

        sqlite3_stmt *stmt;

        if (sqlite3_prepare_v2(db, sql.data(), -1, &stmt, 0) == SQLITE_OK)
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
}
