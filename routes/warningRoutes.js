const express = require('express');
const router = express.Router();
const db = require('../db'); // Points directly to your configured MySQL pool

/**
 * Middleware: Role-Based Authorization
 * Normalizes user roles cleanly to handle frontend role checks robustly.
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const rawRole = req.headers['x-user-role'];
        if (!rawRole) {
            return res.status(401).json({ success: false, message: "Unauthorized: No role provided." });
        }

        const userRole = rawRole.trim().toUpperCase();
        const normalizedAllowed = allowedRoles.map(r => r.toUpperCase());

        if (!normalizedAllowed.includes(userRole)) {
            return res.status(403).json({ success: false, message: `Forbidden: Access denied for ${userRole}.` });
        }
        
        req.normalizedRole = userRole;
        next();
    };
};

/**
 * 1. GET: Warning Statistics
 * Computes escalation buckets across historical incidents.
 */
router.get('/stats', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP', 'Employees']), async (req, res) => {
    const userRole = req.normalizedRole;
    const employeeId = req.headers['x-employee-id'];

    try {
        let sql = "SELECT employee_id FROM warnings WHERE status = 'Approved'";
        let params = [];

        if (userRole === 'EMPLOYEES') {
            if (!employeeId) return res.status(400).json({ success: false, message: "Missing Employee ID" });
            sql += " AND employee_id = ?";
            params.push(employeeId);
        }

        // Execute MySQL Query
        const [rows] = await db.query(sql, params);

        const counts = {};
        let stats = { first: 0, second: 0, final: 0 };

        rows.forEach(w => {
            counts[w.employee_id] = (counts[w.employee_id] || 0) + 1;
            const currentCount = counts[w.employee_id];
            
            if (currentCount === 1) stats.first++;
            else if (currentCount === 2) stats.second++;
            else if (currentCount >= 3) stats.final++;
        });

        res.json({ success: true, ...stats });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * 2. POST: Issue New Warning / Manual Entry
 * Integrates directly with frontend manual entry submission fields.
 */
router.post('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    const { 
        admin_id, admin_name, employee_id, reason, 
        sub_reason, warning_date, explanation, supervisor_comments,
        amount, prevention
    } = req.body;
    const userRole = req.normalizedRole;

    try {
        // Only ER role defaults to structural 'Pending' validation
        const status = (userRole === 'ER') ? 'Pending' : 'Approved';

        // 1. MySQL Insert Statement for warnings table
        const insertSql = `
            INSERT INTO warnings 
            (employee_id, reason, sub_reason, warning_date, explanation, supervisor_comments, amount, prevention, status, issued_by) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const insertParams = [
            employee_id, reason, sub_reason || null, warning_date, 
            explanation || null, supervisor_comments || null, 
            parseFloat(amount) || 0, prevention || null, status, admin_name || "Admin"
        ];

        const [result] = await db.query(insertSql, insertParams);
        const newRecordId = result.insertId; // Grabs the auto-incremented ID

        // 2. MySQL Insert Statement for background audit log tracking
        await db.query(
            "INSERT INTO other_logs (employee_id, employee_name, action, description) VALUES (?, ?, ?, ?)",
            [
                admin_id || "System", 
                admin_name || "Admin", 
                "Warning Created", 
                `Warning issued to ${employee_id}. Status: ${status}`
            ]
        );

        // Construct response to match frontend expectations
        const responseData = {
            id: newRecordId,
            employee_id,
            reason,
            sub_reason: sub_reason || null,
            warning_date,
            explanation: explanation || null,
            supervisor_comments: supervisor_comments || null,
            amount: parseFloat(amount) || 0,
            prevention: prevention || null,
            status,
            issued_by: admin_name || "Admin"
        };

        res.status(201).json({ success: true, message: "Success", data: responseData });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

/**
 * 3. PATCH: Approve Warning
 */
router.patch('/approve/:id', authorize(['Super Admin', 'Supervisors', 'Admin']), async (req, res) => {
    const { id } = req.params;
    const { admin_id, admin_name } = req.body; 

    try {
        // Update statement targets specific row status safely
        const [updateResult] = await db.query(
            "UPDATE warnings SET status = 'Approved', approved_by = ? WHERE id = ? AND status = 'Pending'",
            [admin_name, id]
        );

        if (updateResult.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "Warning not found or already approved." });
        }

        // Log transaction metrics to other_logs table
        await db.query(
            "INSERT INTO other_logs (employee_id, employee_name, action, description) VALUES (?, ?, ?, ?)",
            [
                admin_id || "System", 
                admin_name || "Supervisor", 
                "Warning Approved", 
                `Warning ID ${id} approved by ${admin_name}.`
            ]
        );

        res.json({ success: true, message: "Warning approved successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * 4. PATCH: Update Warning (Edit)
 */
router.patch('/:id', authorize(['Super Admin', 'Admin', 'Supervisors']), async (req, res) => {
    const { id } = req.params;
    const { reason, sub_reason, explanation, warning_date, admin_id, admin_name, amount, prevention } = req.body;

    try {
        const updateSql = `
            UPDATE warnings 
            SET reason = ?, sub_reason = ?, explanation = ?, warning_date = ?, amount = ?, prevention = ? 
            WHERE id = ?
        `;
        const params = [reason, sub_reason, explanation, warning_date, parseFloat(amount) || 0, prevention, id];
        
        const [result] = await db.query(updateSql, params);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "Record not found." });
        }

        await db.query(
            "INSERT INTO other_logs (employee_id, employee_name, action, description) VALUES (?, ?, ?, ?)",
            [
                admin_id || "System", 
                admin_name || "Admin", 
                "Warning Updated", 
                `Warning ID ${id} was modified.`
            ]
        );

        res.json({ 
            success: true, 
            message: "Warning updated successfully", 
            data: { id, reason, sub_reason, explanation, warning_date, amount, prevention } 
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

/**
 * 5. DELETE: Remove Warning
 */
router.delete('/:id', authorize(['Super Admin', 'Admin']), async (req, res) => {
    const { id } = req.params;
    const adminId = req.headers['x-employee-id'];
    const adminName = req.headers['x-employee-name'] || "Admin"; 

    try {
        const [result] = await db.query("DELETE FROM warnings WHERE id = ?", [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "Record not found." });
        }

        await db.query(
            "INSERT INTO other_logs (employee_id, employee_name, action, description) VALUES (?, ?, ?, ?)",
            [
                adminId || "System", 
                adminName, 
                "Warning Deleted", 
                `Warning ID ${id} was permanently deleted.`
            ]
        );

        res.json({ success: true, message: "Warning deleted successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * 6. GET: Employee Search for Autofill
 * Aligned with verified MySQL column 'name' to eliminate field selection crashes.
 */
router.get('/employees/search/:id', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        // Query adjusted to match 'name' field discovered in database description
        const [rows] = await db.query("SELECT name FROM employees WHERE employee_id = ? LIMIT 1", [id]);

        if (rows.length === 0) {
            return res.json({ success: false, message: "Not found" });
        }
        
        // Maps value safely to properties matching your UI setup
        res.json({ success: true, name: rows[0].name });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 7. GET: All Warnings with Search/Filtering Capabilities
 * Connects parameter hooks seamlessly to the search inputs in the UI table.
 */
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP', 'Employees']), async (req, res) => {
    const userRole = req.normalizedRole;
    const employeeId = req.headers['x-employee-id'];
    const { searchId } = req.query;

    try {
        let sql = "SELECT * FROM warnings WHERE 1=1";
        let params = [];

        // Scopes data constraints tightly if requested by standard workforce tier
        if (userRole === 'EMPLOYEES') {
            if (!employeeId) return res.status(400).json({ success: false, message: "Employee ID missing" });
            sql += " AND employee_id = ? AND status = 'Approved'";
            params.push(employeeId);
        } else if (searchId) {
            // Implements robust structural substring queries using wildcards
            sql += " AND (employee_id LIKE ? OR reason LIKE ?)";
            const wildCard = `%${searchId}%`;
            params.push(wildCard, wildCard);
        }

        sql += " ORDER BY warning_date DESC";

        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;