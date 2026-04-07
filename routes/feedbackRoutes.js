const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient'); 

// @route   POST /api/feedback/submit
router.post('/submit', async (req, res) => {
    const { employee_id, employee_name, category, description } = req.body;
    try {
        const { error } = await supabase
            .from('feedback')
            .insert([{ 
                employee_id, 
                employee_name, 
                category, 
                description,
                status: 'pending' 
            }]);

        if (error) throw error;
        res.status(200).json({ success: true, message: "Feedback submitted successfully" });
    } catch (error) {
        console.error("❌ Feedback Submission Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /api/feedback/all
router.get('/all', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('feedback')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("❌ Feedback Fetch Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   PATCH /api/feedback/mark-as-read/:id
router.patch('/mark-as-read/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Ensure id is treated as a number if your DB uses BigInt/Integer
        const numericId = parseInt(id);

        const { data, error, status } = await supabase
            .from('feedback')
            .update({ status: 'read' }) 
            .eq('id', isNaN(numericId) ? id : numericId); // Handles both UUID strings and Integers

        if (error) throw error;

        // Note: Supabase update doesn't throw error if ID isn't found, 
        // it just returns an empty array or status 204.
        res.json({ success: true, message: "Feedback marked as read" });
    } catch (error) {
        console.error("❌ Feedback Update Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}); 

module.exports = router;