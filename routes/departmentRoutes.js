const express = require('express');
const router = express.Router();
const db = require('../db'); // ✅ Pointing to your local MySQL Client

/**
 * AUTH MIDDLEWARE
 * Enforces the permissions from your hierarchy configuration.
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const userRole = req.headers['x-user-role'];
        if (!userRole) {
            return res.status(401).json({ success: false, message: "Unauthorized: No role provided." });
        }
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: `Access Denied: ${userRole} cannot perform this action.` });
        }
        next();
    };
};

/**
 * HELPER: Clean Incoming Data
 * Ensures variables comply with standard column types.
 */
const sanitizeDepartmentData = (data) => {
    const cleaned = { ...data };

    if (cleaned.employees_count === "" || cleaned.employees_count === undefined) {
        cleaned.employees_count = 0;
    } else {
        cleaned.employees_count = parseInt(cleaned.employees_count, 10) || 0;
    }

    return cleaned;
};

// 1. GET: Fetch all departments
// PERMISSION: Super Admin, Supervisors, ER, Admin, TSP
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP']), async (req, res) => {
    try {
        const queryStr = 'SELECT * FROM departments ORDER BY name ASC';
        const [rows] = await db.query(queryStr);
        
        res.json({ success: true, departments: rows });
    } catch (err) {
        console.error("❌ Fetch Error:", err.message);
        res.status(500).json({ success: false, message: "Could not fetch departments." });
    }
});

// 2. POST: Add new department
// PERMISSION: Super Admin, Supervisors, ER, Admin
router.post('/add', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    try {
        const { name, status, employee_id, employee_name } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, message: "Department name is required." });
        }

        const insertData = sanitizeDepartmentData({
            name: name.trim(),
            status: status || 'Active',
            employees_count: 0
        });

        // Insert new department record
        const insertQuery = `
            INSERT INTO departments (name, status, employees_count) 
            VALUES (?, ?, ?)
        `;
        const [insertResult] = await db.query(insertQuery, [
            insertData.name, 
            insertData.status, 
            insertData.employees_count
        ]);

        // Fetch newly created department to emulate PostgREST return structure
        const [newDeptRows] = await db.query('SELECT * FROM departments WHERE id = ?', [insertResult.insertId]);

        // Log action inside other_logs table context
        const logQuery = `
            INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)
        `;
        await db.query(logQuery, [
            employee_id || "System",
            employee_name || "Admin",
            "Department Added",
            `New department '${name}' was successfully created.`
        ]);

        res.status(201).json({ success: true, department: newDeptRows[0] });
    } catch (err) {
        console.error("❌ Add Error:", err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

// 3. PUT: Update department
// PERMISSION: Super Admin, Supervisors, ER, Admin
router.put('/:id', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, status, employee_id, employee_name, employees_count } = req.body;

        const updateData = sanitizeDepartmentData({ name, status, employees_count });

        // Execute update command syntax
        const updateQuery = `
            UPDATE departments 
            SET name = ?, status = ?, employees_count = ? 
            WHERE id = ?
        `;
        await db.query(updateQuery, [
            updateData.name, 
            updateData.status, 
            updateData.employees_count, 
            id
        ]);

        // Fetch newly modified department profile state context
        const [updatedRows] = await db.query('SELECT * FROM departments WHERE id = ?', [id]);

        // Log action trace entries
        const logQuery = `
            INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)
        `;
        await db.query(logQuery, [
            employee_id || "System",
            employee_name || "Admin",
            "Department Updated",
            `Department '${name}' was updated to status: ${status}.`
        ]);

        res.json({ success: true, department: updatedRows[0] });
    } catch (err) {
        console.error("❌ Update Error:", err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

// 4. DELETE: Remove department
// PERMISSION: Super Admin, Supervisors, ER
router.delete('/:id', authorize(['Super Admin', 'Supervisors', 'ER']), async (req, res) => {
    try {
        const { id } = req.params;
        const { employee_id, employee_name, dept_name } = req.query;
        
        if (!id) return res.status(400).json({ success: false, message: "ID is required." });

        const deleteQuery = 'DELETE FROM departments WHERE id = ?';
        await db.query(deleteQuery, [id]);

        // Log record tracking entries safely
        const logQuery = `
            INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)
        `;
        await db.query(logQuery, [
            employee_id || "System",
            employee_name || "Admin",
            "Department Deleted",
            `Department '${dept_name || id}' was permanently removed.`
        ]);

        res.json({ success: true, message: "Department deleted successfully." });
    } catch (err) {
        console.error("❌ Delete Error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;