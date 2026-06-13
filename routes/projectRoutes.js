const express = require('express');
const router = express.Router();
const db = require('../db'); // ✅ Pointing to your local MySQL Client

/**
 * AUTH MIDDLEWARE
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

// 1. GET: Fetch all projects
// PERMISSION: All internal roles
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP', 'Employees']), async (req, res) => {
    try {
        const queryStr = 'SELECT * FROM projects ORDER BY created_date DESC';
        const [rows] = await db.query(queryStr);

        res.json({
            success: true,
            data: rows || []
        });
    } catch (err) {
        console.error("❌ Fetch Error:", err.message);
        res.status(500).json({ success: false, message: "Could not fetch projects." });
    }
});

// 2. POST: Create a new project
router.post('/add', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    try {
        const { name, client, status, deadline, employee_id, employee_name } = req.body;
        const cleanDeadline = deadline === "" ? null : deadline;
        
        // MySQL handles arrays/objects inside JSON type columns as stringified content formats
        const defaultBonusTiers = JSON.stringify([]);

        const insertQuery = `
            INSERT INTO projects (name, client, status, deadline, bonus_tiers) 
            VALUES (?, ?, ?, ?, ?)
        `;
        const [insertResult] = await db.query(insertQuery, [
            name, 
            client, 
            status || 'Active', 
            cleanDeadline, 
            defaultBonusTiers
        ]);

        // Fetch back the newly inserted row entry record
        const [newProjectRows] = await db.query('SELECT * FROM projects WHERE id = ?', [insertResult.insertId]);

        // Log the event trail tracking info updates
        const logQuery = `
            INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)
        `;
        await db.query(logQuery, [
            employee_id || "System",
            employee_name || "Admin",
            "Project Created",
            `A new project '${name}' was created for client '${client}'.`
        ]);

        res.status(201).json({ success: true, project: newProjectRows[0] });
    } catch (err) {
        console.error("❌ Add Error:", err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

// 3. PUT: Update an existing project
router.put('/:id', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, client, status, deadline, bonus_tiers, employee_id, employee_name } = req.body;
        const cleanDeadline = deadline === "" ? null : deadline;
        
        const stringifiedBonusTiers = bonus_tiers ? JSON.stringify(bonus_tiers) : JSON.stringify([]);

        const updateQuery = `
            UPDATE projects 
            SET name = ?, client = ?, status = ?, deadline = ?, bonus_tiers = ? 
            WHERE id = ?
        `;
        await db.query(updateQuery, [
            name, 
            client, 
            status, 
            cleanDeadline, 
            stringifiedBonusTiers, 
            id
        ]);

        // Fetch back modified record structure mapping data representation context
        const [updatedProjectRows] = await db.query('SELECT * FROM projects WHERE id = ?', [id]);

        const logQuery = `
            INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)
        `;
        await db.query(logQuery, [
            employee_id || "System",
            employee_name || "Admin",
            "Project Updated",
            `Project '${name}' was updated.`
        ]);

        res.json({ success: true, project: updatedProjectRows[0] });
    } catch (err) {
        console.error("❌ Update Error:", err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

// 4. DELETE: Permanently remove a project
router.delete('/:id', authorize(['Super Admin', 'Supervisors', 'ER']), async (req, res) => {
    try {
        const { id } = req.params;
        const { employee_id, employee_name, project_name } = req.query;

        const deleteQuery = 'DELETE FROM projects WHERE id = ?';
        await db.query(deleteQuery, [id]);
            
        const logQuery = `
            INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)
        `;
        await db.query(logQuery, [
            employee_id || "System",
            employee_name || "Admin",
            "Project Deleted",
            `Project '${project_name || id}' was permanently removed.`
        ]);

        res.json({ success: true, message: "Project deleted successfully" });
    } catch (err) {
        console.error("❌ Delete Error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;