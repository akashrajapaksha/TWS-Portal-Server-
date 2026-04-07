const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/**
 * 1. GET: සියලුම ලොග් වාර්තා ලබා ගැනීම
 * කිසිදු සීමාවකින් තොරව සියලුම ඓතිහාසික වාර්තා ලබා ගත හැක.
 */
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('other_logs')
            .select('*')
            .order('timestamp', { ascending: false });

        if (error) throw error;

        res.status(200).json({
            success: true,
            data: data || []
        });
    } catch (err) {
        console.error('Fetch Logs Error:', err.message);
        res.status(500).json({ success: false, message: "වාර්තා ලබා ගැනීමට නොහැකි විය." });
    }
});

/**
 * 2. POST: අලුත් ලොග් වාර්තාවක් එක් කිරීම
 */
router.post('/add', async (req, res) => {
    try {
        const { 
            employee_id, 
            employee_name, 
            action, 
            description 
        } = req.body;

        if (!employee_id || !employee_name || !action) {
            return res.status(400).json({ 
                success: false, 
                message: "අසම්පූර්ණ දත්ත (Required fields missing)." 
            });
        }

        const { data, error } = await supabase
            .from('other_logs')
            .insert([{
                employee_id,
                employee_name,
                action,
                description,
                timestamp: new Date().toISOString()
            }])
            .select();

        if (error) throw error;

        res.status(201).json({
            success: true,
            log: data[0]
        });
    } catch (err) {
        console.error('Add Log Error:', err.message);
        res.status(500).json({ success: false, message: "ලොග් එක සටහන් කිරීමට නොහැකි විය." });
    }
});

// වැදගත්: DELETE සහ UPDATE routes මෙහි ඇතුළත් කර නැත. 
// එමඟින් පද්ධතියේ කිසිදු ක්‍රියාවකින් මෙම ලොග්ස් මකා දැමීමට හෝ වෙනස් කිරීමට නොහැකි බව සහතික කරයි.

module.exports = router;