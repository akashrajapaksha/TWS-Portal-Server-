const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: 'aws-1-ap-south-1.pooler.supabase.com',
  user: 'postgres.ygirpiixdjdmzaeaqzxs',
  password: process.env.PG_PASSWORD, // Add this to your .env
  database: 'postgres',
  port: 6543,
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};