const express = require('express');
const router = express.Router();
const mysqlPool = require('../db'); // ✅ Swapped Supabase for local MySQL connection pool

// @route   GET /api/logs
// @desc    සියලුම ලොගින් වාර්තා ලබා ගැනීම
router.get('/', async (req, res) => {
    try {
        // Fetch all logs ordered by the latest login time
        const [rows] = await mysqlPool.query(
            'SELECT * FROM login_logs ORDER BY login_time DESC'
        );

        res.status(200).json({
            success: true,
            data: rows
        });
    } catch (err) {
        console.error('Fetch Logs Error:', err);
        res.status(500).json({ success: false, message: "Failed to fetch logs" });
    }
});

// @route   POST /api/logs/logout
// @desc    Logout වේලාව නිවැරදිව සටහන් කිරීම
router.post('/logout', async (req, res) => {
    const { employee_id } = req.body;

    // 1. Employee ID එක ලැබී ඇත්දැයි පරීක්ෂා කිරීම
    if (!employee_id) {
        return res.status(400).json({ 
            success: false, 
            message: "Employee ID is required for logout" 
        });
    }

    try {
        console.log(`Attempting logout update for: ${employee_id}`);

        // 2. Database එකේ logout_time එක NULL වී පවතින අදාළ සේවකයාගේ රෙකෝඩ් එක Update කිරීම
        // NOW() uses your local MySQL server's timestamp
        const [result] = await mysqlPool.query(
            'UPDATE login_logs SET logout_time = NOW() WHERE employee_id = ? AND logout_time IS NULL',
            [employee_id]
        );

        if (result.affectedRows === 0) {
            console.log(`⚠️ No active session (logout_time IS NULL) found for employee: ${employee_id}`);
            return res.status(404).json({
                success: false,
                message: "No active login session found for this employee."
            });
        }

        return res.status(200).json({
            success: true,
            message: "Logout time recorded successfully"
        });

    } catch (err) {
        console.error('Logout Route Failure:', err);
        return res.status(500).json({ 
            success: false, 
            message: "Internal server error during logout recording" 
        });
    }
});

module.exports = router;