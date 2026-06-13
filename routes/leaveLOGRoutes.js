const express = require('express');
const router = express.Router();
const db = require('../db'); // Assumes your pool connection configuration is exported here

/**
 * 🔐 AUTH MIDDLEWARE
 * Restricts access to specific roles provided in headers.
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const rawRole = req.headers['x-user-role'];
        if (!rawRole) return res.status(401).json({ success: false, message: "Unauthorized: No role provided." });
        
        const userRole = rawRole.trim().toUpperCase();
        const upperAllowed = allowedRoles.map(r => r.toUpperCase());

        if (!upperAllowed.includes(userRole)) {
            return res.status(403).json({ success: false, message: `Access Denied: ${userRole} roles cannot access logs.` });
        }
        next();
    };
};

/**
 * 🛠 REUSABLE DATA FETCHER
 * Merges records from both application tables and sorts by latest apply_date using SQL UNION.
 */
const getCombinedLeaveLogs = async (employeeId = null) => {
    let sql = `
        SELECT * FROM leave_applications
        ${employeeId ? 'WHERE employee_id = ?' : ''}
        UNION ALL
        SELECT * FROM leave_applications_two
        ${employeeId ? 'WHERE employee_id = ?' : ''}
        ORDER BY apply_date DESC
    `;

    // Map parameters based on whether an employeeId filter is active
    const params = employeeId ? [employeeId, employeeId] : [];

    // Execute using mysql2/promise pool structure
    const [rows] = await db.execute(sql, params);
    return rows;
};

/**
 * 📄 GET: Fetch All Logs
 */
router.get('/all-logs', authorize(['Super Admin', 'ER']), async (req, res) => {
    try {
        const logs = await getCombinedLeaveLogs();
        res.status(200).json({
            success: true,
            count: logs.length,
            logs: logs
        });
    } catch (err) {
        console.error('Fetch Error:', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Failed to retrieve leave log records from the database.", 
            error: err.message 
        });
    }
});

/**
 * 🔍 GET: Search Logs by Employee ID
 */
router.get('/search/:empId', authorize(['Super Admin', 'ER']), async (req, res) => {
    try {
        const { empId } = req.params;
        const logs = await getCombinedLeaveLogs(empId);
        res.status(200).json({
            success: true,
            count: logs.length,
            logs: logs
        });
    } catch (err) {
        console.error('Search Error:', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Search operation failed due to a database processing error.", 
            error: err.message 
        });
    }
});

module.exports = router;