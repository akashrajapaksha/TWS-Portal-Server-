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

// 2. POST: Add new performance record + Audit Log
router.post('/add', authorize(['Super Admin', 'Supervisors', 'TSP', 'LD']), async (req, res) => {
    try {
        const { 
            employee_id, employee_name, project, 
            employee_position, date, shift, 
            order_count, admin_id, admin_name 
        } = req.body;

        const cleanEmployeeId = employee_id.trim().toUpperCase();
        const parsedOrderCount = parseInt(order_count) || 0;

        // Step A: Insert Performance Record
        const [insertResult] = await mysqlPool.query(
            `INSERT INTO orders 
            (employee_id, employee_name, project, employee_position, date, shift, order_count) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [cleanEmployeeId, employee_name, project, employee_position, date, shift, parsedOrderCount]
        );

        // Fetch the newly inserted record to return it back to your frontend state seamlessly
        const [newRecord] = await mysqlPool.query('SELECT * FROM orders WHERE id = ?', [insertResult.insertId]);

        // Step B: Audit Logging (Now points to your local other_logs table)
        await mysqlPool.query(
            `INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)`,
            [
                admin_id || "System",
                admin_name || "Admin",
                "Performance Added",
                `Performance (Count: ${parsedOrderCount}) logged for ${employee_name} by ${admin_name}.`
            ]
        );

        res.status(201).json({ success: true, order: newRecord[0] });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
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