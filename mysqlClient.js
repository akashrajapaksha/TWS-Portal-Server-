const mysql = require('mysql2/promise'); // Correct: This allows for await db.query()
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'attendance', // Verified database name from image_95ce93.jpg
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    // Add these to prevent common JDM/Import character set issues if you use Japanese text
    charset: 'utf8mb4' 
});

// Testing the connection on startup to catch errors immediately
pool.getConnection()
    .then(connection => {
        console.log('✅ Connected to MySQL Database: ' + (process.env.MYSQL_DATABASE || 'attendance'));
        connection.release();
    })
    .catch(err => {
        console.error('❌ MySQL Connection Failed:', err.message);
    });

module.exports = pool;