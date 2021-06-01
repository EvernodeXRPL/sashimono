/**
    Entry point for Sashimono
**/
#include "pchheader.hpp"
#include "sqlite.hpp"

int main(int argc, char **argv)
{
    std::cout << "sashimono agent started.\n";

    sqlite3 *db = NULL;
    const char *path = "db.sqlite";

    if (sqlite::open_db(path, &db, true) == -1)
    {
        std::cerr << "Error opening database\n";
        return -1;
    }
    std::cout << "Database " << path << " opened successfully\n";

    const std::vector<sqlite::table_column_info> column_info{
        sqlite::table_column_info("VERSION", sqlite::COLUMN_DATA_TYPE::TEXT)};

    if (create_table(db, "SA_VERSION", column_info) == -1)
        return -1;

    if (sqlite::insert_row(db, "SA_VERSION", "VERSION", "\"0.0.0\"") == -1)
        return -1;

    if (sqlite::close_db(&db) == -1)
    {
        std::cerr << "Error closing database\n";
        return -1;
    }

    std::cout << "sashimono agent exited normally.\n";
    return 0;
}
