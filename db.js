const mysql = require('mysql2/promise'); 
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'portal', 
    port: process.env.MYSQL_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: 'utf8mb4' 
});

// Testing the connection on startup
pool.getConnection()
    .then(connection => {
        console.log('✅ Connected to MySQL Server instance.');
        console.log('   Primary DB:', process.env.MYSQL_DATABASE || 'your_primary_db_name');
        console.log('   Secondary DB: attendance (Accessible via queries)');
        connection.release();
    })
    .catch(err => {
        console.error('❌ MySQL Connection Failed:', err.message);
    });

module.exports = pool;