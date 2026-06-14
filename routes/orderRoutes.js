const express = require('express');
const router = express.Router();
const mysqlPool = require('../db'); // ✅ Swapped Supabase for local MySQL connection pool

/**
 * Middleware: Role-Based Access Control (RBAC)
 * Strictly enforces that 'x-user-role' is present and allowed.
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const userRole = req.headers['x-user-role'];
        if (!userRole) return res.status(401).json({ success: false, message: "Unauthorized: Missing Role" });
        
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: `Access Denied for ${userRole}` });
        }
        next();
    };
};

// 0. GET: Employee ID Lookup (Used for auto-filling form names)
router.get('/fetch-by-id/:id', async (req, res) => {
    try {
        const cleanId = req.params.id.trim().toUpperCase();

        const [rows] = await mysqlPool.query(
            'SELECT name, designation, project FROM employees WHERE employee_id = ? LIMIT 1',
            [cleanId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        res.json({
            success: true,
            name: rows[0].name,
            designation: rows[0].designation,
            project: rows[0].project
        });
    } catch (err) {
        console.error('Fetch Employee Error:', err);
        res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

// 1. GET: Fetch all performance records (Sorted by most recent)
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP', 'LD']), async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            'SELECT * FROM orders ORDER BY date DESC'
        );
        
        res.json({ success: true, orders: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. POST: Add multiple performance records in bulk + Audit Log
router.post('/add', authorize(['Super Admin', 'Supervisors', 'TSP', 'LD']), async (req, res) => {
    // Acquire an explicit individual connection handler to safely manage transactions
    const connection = await mysqlPool.getConnection();
    try {
        const { 
            employee_id, employee_name, project, employee_position, 
            entries, // 👈 Expecting structural array: [{ date, shift, order_count }, ...]
            admin_id, admin_name 
        } = req.body;

        if (!entries || !Array.isArray(entries) || entries.length === 0) {
            return res.status(400).json({ success: false, message: "Invalid payload: 'entries' must be a non-empty array." });
        }

        const cleanEmployeeId = employee_id.trim().toUpperCase();
        
        // Begin ACID safe database storage transaction
        await connection.beginTransaction();

        const insertedRecords = [];
        let totalOrdersLogged = 0;

        // Loop and write each sub-date configuration row into your system storage
        for (const entry of entries) {
            const parsedOrderCount = parseInt(entry.order_count) || 0;
            totalOrdersLogged += parsedOrderCount;

            const [insertResult] = await connection.query(
                `INSERT INTO orders 
                (employee_id, employee_name, project, employee_position, date, shift, order_count) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [cleanEmployeeId, employee_name, project, employee_position, entry.date, entry.shift, parsedOrderCount]
            );

            // Fetch the newly written line-item row immediately
            const [newRecord] = await connection.query('SELECT * FROM orders WHERE id = ?', [insertResult.insertId]);
            if (newRecord.length > 0) {
                insertedRecords.push(newRecord[0]);
            }
        }

        // Step B: Structural Audit Logging block tracking total logs injected
        await connection.query(
            `INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)`,
            [
                admin_id || "System",
                admin_name || "Admin",
                "Performance Added",
                `Logged ${entries.length} days of performance metrics (Total Orders: ${totalOrdersLogged}) for ${employee_name} by ${admin_name}.`
            ]
        );

        // Commit all queued records cleanly to disk
        await connection.commit();
        
        // Return bulk array elements back to your state manager seamlessly
        res.status(201).json({ success: true, orders: insertedRecords });
    } catch (err) {
        // Rollback transaction to protect table alignment if any row loops experience errors
        await connection.rollback();
        console.error("Bulk Insert Execution Crash:", err);
        res.status(400).json({ success: false, message: err.message });
    } finally {
        // Always return raw client connection controls back to management pool
        connection.release();
    }
});

// 3. PUT: Update existing record + Audit Log
router.put('/:id', authorize(['Super Admin', 'Supervisors', 'TSP', 'LD']), async (req, res) => {
    try {
        const { 
            employee_id, employee_name, project, 
            employee_position, date, shift, 
            order_count, admin_id, admin_name 
        } = req.body;

        const cleanEmployeeId = employee_id.trim().toUpperCase();
        const parsedOrderCount = parseInt(order_count) || 0;
        const recordId = req.params.id;

        // Step A: Update Record
        await mysqlPool.query(
            `UPDATE orders 
            SET employee_id = ?, employee_name = ?, project = ?, employee_position = ?, date = ?, shift = ?, order_count = ? 
            WHERE id = ?`,
            [cleanEmployeeId, employee_name, project, employee_position, date, shift, parsedOrderCount, recordId]
        );

        // Fetch the updated record for frontend synchronization
        const [updatedRecord] = await mysqlPool.query('SELECT * FROM orders WHERE id = ?', [recordId]);

        // Step B: Audit Logging
        await mysqlPool.query(
            `INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)`,
            [
                admin_id || "System",
                admin_name || "Admin",
                "Performance Updated",
                `Performance record for ${employee_name} was modified by ${admin_name}.`
            ]
        );

        res.json({ success: true, order: updatedRecord[0] });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// 4. DELETE: Remove record + Audit Log
router.delete('/:id', authorize(['Super Admin', 'Supervisors', 'TSP']), async (req, res) => {
    try {
        const { admin_id, admin_name, emp_name } = req.query;
        const recordId = req.params.id;

        // Step A: Delete from Orders
        await mysqlPool.query('DELETE FROM orders WHERE id = ?', [recordId]);

        // Step B: Audit Logging
        await mysqlPool.query(
            `INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)`,
            [
                admin_id || "System",
                admin_name || "Admin",
                "Performance Deleted",
                `Performance log for ${emp_name} was permanently deleted by ${admin_name}.`
            ]
        );

        res.json({ success: true, message: "Deleted successfully" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;