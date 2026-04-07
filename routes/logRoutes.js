const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

// @route   GET /api/logs
// @desc    සියලුම ලොගින් වාර්තා ලබා ගැනීම
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('login_logs')
            .select('*')
            .order('login_time', { ascending: false });

        if (error) throw error;

        res.status(200).json({
            success: true,
            data: data
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
        const { data, error } = await supabase
            .from('login_logs')
            .update({ 
                logout_time: new Date().toISOString() 
            })
            .eq('employee_id', employee_id)
            .is('logout_time', null); // මේ කොන්දේසිය නිසා දැනට ලොග් වී සිටින සෙෂන් එක පමණක් අප්ඩේට් වේ

        if (error) {
            console.error('Supabase DB Update Error:', error.message);
            throw error;
        }

        return res.status(200).json({
            success: true,
            message: "Logout time recorded successfully",
            updatedData: data
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