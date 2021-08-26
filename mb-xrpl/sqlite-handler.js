const sqlite3 = require('sqlite3').verbose();

const DataTypes = {
    TEXT: 'TEXT',
    INTEGER: 'INTEGER',
    NULL: 'NULL'
}

class SqliteDatabase {
    constructor(dbFile) {
        this.db = new sqlite3.Database(dbFile);
    }

    createTableIfNotExists(tableName, columnInfo) {
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
        this.db.run(query);
    }

    insertValue(tableName, value) {
        this.insertValues(tableName, [value]);
    }

    updateValue(tableName, value, filter) {
        let columnNames = Object.keys(value);
        let values = [];
        for (const columnName of columnNames)
            values.push(`${columnName} = '${value[columnName]}'`);
        columnNames = Object.keys(filter);
        let filters = [];
        for (const columnName of columnNames)
            filters.push(`${columnName} = '${filter[columnName]}'`);
        const valueStr = values.join(', ');
        const filterStr = filters.join(' && ');
        const query = `UPDATE ${tableName} SET ${valueStr} WHERE ${filterStr}`;
        this.db.run(query);
    }

    insertValues(tableName, values) {
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
            this.db.run(query);
        }
    }
}

module.exports = {
    SqliteDatabase,
    DataTypes
}