const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

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
 * Fetches from both tables, applies optional filters, merges, and sorts.
 */
const getCombinedLeaveLogs = async (employeeId = null) => {
    // Define queries for both tables
    let query1 = supabase.from('leave_applications').select('*');
    let query2 = supabase.from('leave_applications_two').select('*');

    // If an employeeId is provided, apply the filter to both queries
    if (employeeId) {
        query1 = query1.eq('employee_id', employeeId);
        query2 = query2.eq('employee_id', employeeId);
    }

    // Execute both queries in parallel for better performance
    const [res1, res2] = await Promise.all([query1, query2]);

    // Error handling
    if (res1.error) throw res1.error;
    if (res2.error) throw res2.error;

    // Merge arrays and sort by apply_date (Descending - Latest first)
    return [...(res1.data || []), ...(res2.data || [])].sort((a, b) => 
        new Date(b.apply_date) - new Date(a.apply_date)
    );
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
        res.status(500).json({ success: false, message: "දත්ත ලබා ගැනීමට නොහැකි විය.", error: err.message });
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
        res.status(500).json({ success: false, message: "සෙවුම අසාර්ථක විය.", error: err.message });
    }
});

module.exports = router;