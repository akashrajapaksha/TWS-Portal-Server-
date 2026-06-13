const express = require('express');
const router = express.Router();
const db = require('../db'); // Assumes your pool connection configuration is exported here

/**
 * 1. GET: Fetch All Log Records
 * Retrieves all historical audit entries sorted from newest to oldest.
 */
router.get('/', async (req, res) => {
    try {
        const sql = `
            SELECT * FROM other_logs 
            ORDER BY timestamp DESC
        `;
        
        const [rows] = await db.execute(sql);

        res.status(200).json({
            success: true,
            data: rows || []
        });
    } catch (err) {
        console.error('Fetch Logs Error:', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Failed to retrieve systemic logs from the database." 
        });
    }
});

/**
 * 2. POST: Insert New Log Record
 */
router.post('/add', async (req, res) => {
    try {
        const { 
            employee_id, 
            employee_name, 
            action, 
            description 
        } = req.body;

        // Validation rule validation checking
        if (!employee_id || !employee_name || !action) {
            return res.status(400).json({ 
                success: false, 
                message: "Incomplete log payload: Missing required structural tracking fields." 
            });
        }

        const sql = `
            INSERT INTO other_logs (employee_id, employee_name, action, description, timestamp)
            VALUES (?, ?, ?, ?, NOW())
        `;
        
        const params = [employee_id, employee_name, action, description || null];
        const [result] = await db.execute(sql, params);

        res.status(201).json({
            success: true,
            message: "Log entry successfully cataloged.",
            logId: result.insertId
        });
    } catch (err) {
        console.error('Add Log Error:', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Failed to submit log snapshot trace to the repository." 
        });
    }
});

// IMPORTANT: Update and delete routes are intentionally omitted from this module. 
// This structural setup ensures historical compliance data remains immutable and unalterable.

module.exports = router;