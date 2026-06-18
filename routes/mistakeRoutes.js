const express = require('express');
const router = express.Router();
const mysqlPool = require('../db'); // ✅ Swapped Supabase for local MySQL connection pool

/**
 * LOGIC CONSTANTS
 * ZERO_COUNT_MISTAKES: Administrative or financial logs that should not decrease 
 * performance or count as a "Mistake" in the dashboard total.
 * MONEY_MISTAKES: Types that require an amount to be recorded.
 */
const ZERO_COUNT_MISTAKES = [
    "DOUBLE PAY", 
    "LOCK A BANK", 
    "BREAK", 
    "DOUBLE APPROVE SAME TICKET", 
    "MONEY SHORT"
];

const MONEY_MISTAKES = ["DOUBLE PAY", "MONEY SHORT"];

/**
 * HELPER: processMistakeData
 * Logic: 
 * 1. If type is money-related, record the amount.
 * 2. If type is in ZERO_COUNT_MISTAKES, the 'count' is forced to 0.
 * 3. Standard mistakes (like WRONG KEY) get count: 1 and amount: 0.
 */
const processMistakeData = (body) => {
    const { mistake_type, amount, count } = body;
    let finalAmount = 0;
    let finalCount = 0;

    // Determine Amount
    if (MONEY_MISTAKES.includes(mistake_type)) {
        finalAmount = parseFloat(amount) || 0;
    } else {
        finalAmount = 0;
    }

    // Determine Count
    if (ZERO_COUNT_MISTAKES.includes(mistake_type)) {
        finalCount = 0; 
    } else {
        finalCount = parseInt(count) || 1;
    }

    return { ...body, amount: finalAmount, count: finalCount };
};

/**
 * 0. GET: Auto-fetch Employee Details
 */
router.get('/fetch-by-id/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cleanId = id.trim().toUpperCase();

        const [rows] = await mysqlPool.query(
            'SELECT name, designation, project FROM employees WHERE employee_id = ? LIMIT 1',
            [cleanId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        return res.json({
            success: true,
            name: rows[0].name,
            designation: rows[0].designation,
            project: rows[0].project
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

/**
 * 1. POST: Add Mistake
 */
router.post('/add', async (req, res) => {
    try {
        const { admin_id, admin_name, userRole } = req.body;
        
        const allowedRoles = ['Super Admin', 'Supervisors', 'TPS', 'LD'];
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: "Unauthorized to add records." });
        }

        const cleanData = processMistakeData(req.body);

        // Step A: Insert into local MySQL 'mistakes' table
        const [insertResult] = await mysqlPool.query(
            `INSERT INTO mistakes 
            (employeeid, employee_name, project, employee_position, date, shift, mistake_type, amount, count) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                cleanData.employeeid.trim().toUpperCase(),
                cleanData.employee_name,
                cleanData.project,
                cleanData.employee_position,
                cleanData.date,
                cleanData.shift,
                cleanData.mistake_type,
                cleanData.amount,
                cleanData.count
            ]
        );

        // Fetch back the created row to return to client
        const [newRecord] = await mysqlPool.query('SELECT * FROM mistakes WHERE id = ?', [insertResult.insertId]);

        // Step B: Write Audit Logs
        await mysqlPool.query(
            `INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)`,
            [
                admin_id || "System",
                admin_name || "Admin",
                "Mistake Added",
                `Admin ${admin_name} added a '${cleanData.mistake_type}' mistake for ${cleanData.employee_name}.`
            ]
        );

        res.status(201).json({ success: true, mistake: newRecord[0] });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 2. PUT: Update Mistake
 */
router.put('/:id', async (req, res) => {
    try {
        const { admin_id, admin_name, userRole } = req.body;
        const mistakeId = req.params.id;

        const allowedRoles = ['Super Admin', 'Supervisors', 'TPS', 'LD'];
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: "Unauthorized to update records." });
        }

        const cleanData = processMistakeData(req.body);

        // Step A: Update mistakes table
        await mysqlPool.query(
            `UPDATE mistakes 
            SET employeeid = ?, employee_name = ?, project = ?, employee_position = ?, date = ?, shift = ?, mistake_type = ?, amount = ?, count = ? 
            WHERE id = ?`,
            [
                cleanData.employeeid.trim().toUpperCase(),
                cleanData.employee_name,
                cleanData.project,
                cleanData.employee_position,
                cleanData.date,
                cleanData.shift,
                cleanData.mistake_type,
                cleanData.amount,
                cleanData.count,
                mistakeId
            ]
        );

        // Get the updated record
        const [updatedRecord] = await mysqlPool.query('SELECT * FROM mistakes WHERE id = ?', [mistakeId]);

        // Step B: Log the edit action
        await mysqlPool.query(
            `INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)`,
            [
                admin_id || "System",
                admin_name || "Admin",
                "Mistake Updated",
                `Mistake for ${cleanData.employee_name} updated by ${admin_name}.`
            ]
        );

        res.json({ success: true, mistake: updatedRecord[0] });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 3. GET: Fetch All
 */
router.get('/', async (req, res) => {
    try {
        const [rows] = await mysqlPool.query(
            'SELECT * FROM mistakes ORDER BY date DESC'
        );
        res.json({ success: true, mistakes: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 4. DELETE: Delete Mistake
 */
router.delete('/:id', async (req, res) => {
    try {
        const { admin_id, admin_name, emp_name, mistake_type, userRole } = req.query;
        const mistakeId = req.params.id;

        const allowedRoles = ['Super Admin', 'Supervisors', 'TPS'];
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: "Unauthorized to delete record." });
        }

        // Step A: Delete Row
        await mysqlPool.query('DELETE FROM mistakes WHERE id = ?', [mistakeId]);
            
        // Step B: Write Audit Logs
        await mysqlPool.query(
            `INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)`,
            [
                admin_id || "System",
                admin_name || "Admin",
                "Mistake Deleted",
                `The '${mistake_type}' record of ${emp_name} was deleted by ${admin_name}.`
            ]
        );

        res.json({ success: true, message: "Record deleted" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 5. POST: Promote Mistake to IR
 * FIXED: Validates the logic check against the threshold minimum of 6.
 */
router.post('/promote-to-ir', async (req, res) => {
    try {
        const { mistake, admin_id, admin_name, userRole } = req.body;

        const allowedRoles = ['Super Admin', 'Supervisors', 'TPS', 'LD'];
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: "Unauthorized to promote records." });
        }

        // ✅ FIXED: Corrected logic check to accurately block promotion if threshold is below 6
        const currentCount = parseInt(mistake.count) || 0;
        if (currentCount < 6) {
            return res.status(400).json({ 
                success: false, 
                message: `Mistake count is ${currentCount}. A minimum of 6 mistakes is required to issue an IR.` 
            });
        }

        // Step A: Insert incident report into your MySQL architecture
        const [irInsertResult] = await mysqlPool.query(
            `INSERT INTO incident_reports 
            (full_name, emp_no, incident_details, incident_date, amount, status, admin_id, position, description) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                mistake.employee_name,
                String(mistake.employeeid).trim().toUpperCase(),
                `[PROMOTED FROM MISTAKE]: ${mistake.mistake_type} (Total Cases: ${currentCount})`,
                mistake.date,
                parseFloat(mistake.amount || 0),
                'created',
                String(admin_id),
                mistake.employee_position || 'General Staff',
                `Automatically generated IR based on high mistake volume (6+) logged by ${admin_name}.`
            ]
        );

        // Fetch new incident report row
        const [newIR] = await mysqlPool.query('SELECT * FROM incident_reports WHERE id = ?', [irInsertResult.insertId]);

        // Step B: Write Promotion Log Entry
        await mysqlPool.query(
            `INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description) 
            VALUES (?, ?, ?, NOW(), ?)`,
            [
                admin_id || "System",
                admin_name || "Admin",
                "MISTAKE_PROMOTED_TO_IR",
                `Admin ${admin_name} promoted mistake log of ${mistake.employee_name} to an official IR. Final count: ${currentCount}.`
            ]
        );

        res.status(201).json({ success: true, message: "IR successfully issued (Threshold of 6 reached)", data: newIR[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;