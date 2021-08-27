const sqlite3 = require('sqlite3').verbose();

const DataTypes = {
    TEXT: 'TEXT',
    INTEGER: 'INTEGER',
    NULL: 'NULL'
}

class SqliteDatabase {
    constructor(dbFile) {
        this.dbFile = dbFile;
    }

    open() {
        this.db = new sqlite3.Database(this.dbFile);
    }

    close() {
        this.db.close();
        this.db = null;
    }

    createTableIfNotExists(tableName, columnInfo) {
        if (!this.db)
            throw 'Database connection is not open.';

        const columns = columnInfo.map(c => {
            let info = `${c.name} ${c.type}`;
            if (c.default)
                info += ` DEFAULT ${c.default}`;
            if (c.unique)
                info += ' UNIQUE';
            if (c.primary)
                info += ' PRIMARY KEY';
            if (c.notNull)
                info += ' NOT NULL';
            return info;
        }).join(', ');

        const query = `CREATE TABLE IF NOT EXISTS ${tableName}(${columns})`;
        this.runQuery(query);
    }

    getValues(tableName, filter = null) {
        if (!this.db)
            throw 'Database connection is not open.';

        let filters = [];
        if (filter) {
            const columnNames = Object.keys(filter);
            for (const columnName of columnNames)
                filters.push(`${columnName} = '${filter[columnName]}'`);
        }
        const filterStr = filters.join(' && ');
        const query = `SELECT * FROM ${tableName}` + (filterStr ? ` WHERE ${filterStr};` : ';');
        return new Promise((resolve, reject) => {
            let rows = [];
            this.db.each(query, (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }

                rows.push(row);
            }, (err, count) => {
                if (err) {
                    reject(err);
                    return;
                }

                resolve(rows);
            });
        });
    }

    insertValue(tableName, value) {
        this.insertValues(tableName, [value]);
    }

    updateValue(tableName, value, filter = null) {
        if (!this.db)
            throw 'Database connection is not open.';

        let columnNames = Object.keys(value);
        let values = [];
        for (const columnName of columnNames)
            values.push(`${columnName} = '${value[columnName]}'`);
        const valueStr = values.join(', ');
        let filters = [];
        if (filter) {
            columnNames = Object.keys(filter);
            for (const columnName of columnNames)
                filters.push(`${columnName} = '${filter[columnName]}'`);
        }
        const filterStr = filters.join(' && ');
        const query = `UPDATE ${tableName} SET ${valueStr}` + (filterStr ? ` WHERE ${filterStr};` : ';');
        this.runQuery(query);
    }

    insertValues(tableName, values) {
        if (!this.db)
            throw 'Database connection is not open.';

        if (values.length) {
            const columnNames = Object.keys(values[0]);
            let rows = [];
            for (const val of values) {
                let rowValues = [];
                for (const columnName of columnNames)
                    rowValues.push(`'${val[columnName]}'`);
                rows.push(`(${rowValues.join(', ')})`);
            }
            const columnStr = columnNames.join(', ');
            const valueStr = rows.join(', ');

            const query = `INSERT INTO ${tableName}(${columnStr}) VALUES ${valueStr}`;
            this.runQuery(query);
        }
    }

    runQuery(query) {
        this.db.run(query, (err) => {
            if (err)
                throw err;
        });
    }
}

module.exports = {
    SqliteDatabase,
    DataTypes
}