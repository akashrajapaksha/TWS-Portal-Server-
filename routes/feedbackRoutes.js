const express = require('express');
const router = express.Router();
const db = require('../db'); // Your working MySQL Client Pool configuration

// @route   POST /api/feedback/submit
router.post('/submit', async (req, res) => {
    const { employee_id, employee_name, category, description } = req.body;
    
    try {
        const mysqlQuery = `
            INSERT INTO feedback 
            (employee_id, employee_name, category, description, status) 
            VALUES (?, ?, ?, ?, 'pending')
        `;

        await db.execute(mysqlQuery, [
            employee_id || null,
            employee_name || null,
            category || null,
            description || null
        ]);

        res.status(200).json({ success: true, message: "Feedback submitted successfully" });
    } catch (error) {
        console.error("❌ Feedback Submission Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   GET /api/feedback/all
router.get('/all', async (req, res) => {
    try {
        // Fetching records ordered by submission time from newest to oldest
        const [rows] = await db.execute(
            "SELECT * FROM feedback ORDER BY created_at DESC"
        );

        res.json(rows);
    } catch (error) {
        console.error("❌ Feedback Fetch Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// @route   PATCH /api/feedback/mark-as-read/:id
router.patch('/mark-as-read/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Convert route param to a standard integer to match MySQL AUTO_INCREMENT keys
        const numericId = parseInt(id, 10);
        if (isNaN(numericId)) {
            return res.status(400).json({ success: false, error: "Invalid feedback ID format." });
        }

        const [result] = await db.execute(
            "UPDATE feedback SET status = 'read' WHERE id = ?",
            [numericId]
        );

        // Check if a row actually matched the ID sent by the client
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "Feedback record not found." });
        }

        res.json({ success: true, message: "Feedback marked as read" });
    } catch (error) {m
        console.error("❌ Feedback Update Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}); 

module.exports = router;