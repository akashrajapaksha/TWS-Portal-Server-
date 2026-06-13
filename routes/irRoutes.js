const express = require('express');
const router = express.Router();
const mysqlPool = require('../db'); // Your native MySQL pool connector

// List of high-severity mistakes that trigger an IR regardless of count
const HIGH_SEVERITY_MISTAKES = [
    "DOUBLE PAY", 
    "LOCK A BANK", 
    "BREAK", 
    "DOUBLE APPROVE SAME TICKET", 
    "MONEY SHORT"
];

/**
 * 1. Auto-fetch Employee Details by ID
 */
router.get('/fetch-by-id/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const [rows] = await mysqlPool.query(
            `SELECT name, initials, designation FROM employees WHERE employee_id = ? LIMIT 1`,
            [id.trim().toUpperCase()]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        const employee = rows[0];
        return res.json({
            success: true,
            name: employee.name,
            initials: employee.initials || '',
            position: employee.designation || 'Staff' 
        });
    } catch (err) {
        console.error("Fetch Error:", err.message);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

/**
 * 2. GET: Fetch Incident Reports (IR)
 * Logic: Triggers if (Daily Mistakes >= 3) OR (Contains High Severity Mistake)
 */
router.get('/', async (req, res) => {
    try {
        const { userRole, loggedInEmployeeId, searchId } = req.query;

        // --- FETCH EXISTING IRS ---
        let irQuery = `SELECT * FROM incident_reports WHERE 1=1`;
        const irParams = [];

        if (userRole === 'Employees') {
            irQuery += ` AND emp_no = ?`;
            irParams.push(String(loggedInEmployeeId).trim());
        } else if (searchId) {
            irQuery += ` AND emp_no = ?`;
            irParams.push(String(searchId).trim().toUpperCase());
        }

        irQuery += ` ORDER BY incident_date DESC`;
        const [existingIRResult] = await mysqlPool.query(irQuery, irParams);
        const existingIR = existingIRResult || [];

        let formattedPending = [];
        const privilegedRoles = ['Super Admin', 'Supervisors', 'ER', 'TSP', 'LD', 'Admin'];
        
        if (privilegedRoles.includes(userRole)) {
            // --- NATIVE REPLACEMENT FOR THE RPC 'get_pending_ir_candidates' ---
            // Aggregates mistakes grouped by day and user, fetching the associated designation metadata
            const rawPendingQuery = `
                SELECT 
                    m.employeeid AS official_emp_no,
                    e.name AS name,
                    e.designation AS position,
                    m.date AS mistake_date,
                    SUM(m.count) AS total_mistake_count,
                    SUM(m.amount) AS total_amount,
                    GROUP_CONCAT(m.mistake_type SEPARATOR ', ') AS combined_mistakes
                FROM mistakes m
                JOIN employees e ON m.employeeid = e.employee_id
                GROUP BY m.employeeid, m.date, e.name, e.designation
            `;
            
            const [pendingCandidates] = await mysqlPool.query(rawPendingQuery);

            if (pendingCandidates && pendingCandidates.length > 0) {
                // Map tracking keys for rows that are already promoted to official records
                const existingKeys = new Set(
                    existingIR.map(ir => `${String(ir.emp_no).trim()}-${ir.incident_date}`)
                );

                formattedPending = pendingCandidates
                    .filter(p => {
                        const pendingKey = `${String(p.official_emp_no).trim()}-${p.mistake_date}`;
                        const details = (p.combined_mistakes || "").toUpperCase();
                        
                        const hasHighSeverity = HIGH_SEVERITY_MISTAKES.some(m => details.includes(m));
                        const hasHighFrequency = parseInt(p.total_mistake_count) >= 3;

                        return !existingKeys.has(pendingKey) && (hasHighFrequency || hasHighSeverity);
                    })
                    .map(p => {
                        const details = (p.combined_mistakes || "").toUpperCase();
                        const isHighSeverity = HIGH_SEVERITY_MISTAKES.some(m => details.includes(m));
                        const isMonetary = details.includes("MONEY SHORT") || details.includes("DOUBLE PAY");

                        return {
                            id: `pending-${p.official_emp_no}-${p.mistake_date}`,
                            emp_no: String(p.official_emp_no),
                            full_name: p.name,
                            incident_date: p.mistake_date,
                            incident_details: isHighSeverity 
                                ? `[CRITICAL MISTAKE]: ${p.combined_mistakes}`
                                : `[DAILY THRESHOLD]: ${p.total_mistake_count} mistakes on ${p.mistake_date}`,
                            mistake_count: parseInt(p.total_mistake_count) || 0,
                            amount: isMonetary ? parseFloat(p.total_amount || 0) : 0,
                            status: 'pending',
                            position: p.position || 'General Staff'
                        };
                    });
            }
        }

        return res.status(200).json({ 
            success: true, 
            data: [...formattedPending, ...existingIR] 
        });

    } catch (err) {
        console.error("Server Error (GET IR):", err.message);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

/**
 * 3. POST: Create New IR (Manual)
 */
router.post('/add', async (req, res) => {
    try {
        const { 
            fullName, nickName, initials, empNo, position, 
            details, dateIncident, description, prevention, 
            adminId, adminName, amount, userRole 
        } = req.body;

        if (userRole === 'Employees') return res.status(403).json({ success: false, error: "Access Denied." });

        // Insert new Incident Report
        const insertIRQuery = `
            INSERT INTO incident_reports 
            (full_name, nick_name, initials, emp_no, incident_details, incident_date, description, prevention, admin_id, position, status, amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?)
        `;
        const irValues = [
            fullName, nickName || '', initials || '', String(empNo).trim().toUpperCase(),
            details, dateIncident, description || '', prevention || '', String(adminId), position || 'General Staff', parseFloat(amount || 0)
        ];

        const [irResult] = await mysqlPool.query(insertIRQuery, irValues);

        // Append log history
        const logQuery = `
            INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description)
            VALUES (?, ?, 'IR_ISSUED', ?, ?)
        `;
        const logValues = [
            String(adminId), adminName || "System", new Date().toISOString(), `Official IR issued to ${fullName} (${empNo}).`
        ];
        await mysqlPool.query(logQuery, logValues);

        return res.status(201).json({ 
            success: true, 
            data: { id: irResult.insertId, emp_no: empNo, full_name: fullName, status: 'created' } 
        });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 4. DELETE: Remove IR
 */
router.delete('/:id', async (req, res) => {
    try {
        const { userRole } = req.query;
        const allowedToDelete = ['Super Admin', 'Supervisors', 'ER', 'TSP', 'LD'];
        if (!allowedToDelete.includes(userRole)) return res.status(403).json({ success: false, error: "Unauthorized." });

        const [result] = await mysqlPool.query(`DELETE FROM incident_reports WHERE id = ?`, [req.params.id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "Record not found" });
        }

        return res.json({ success: true, message: "Deleted successfully" });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 5. POST: Promote Mistake to IR
 */
router.post('/promote-from-mistake', async (req, res) => {
    try {
        const { mistake, adminId, adminName, userRole } = req.body;
        const allowedRoles = ['Super Admin', 'Supervisors', 'TSP', 'LD', 'Admin'];
        
        if (!allowedRoles.includes(userRole)) return res.status(403).json({ success: false, error: "Unauthorized." });

        const details = (mistake.incident_details || "").toUpperCase();
        const isHighSeverity = HIGH_SEVERITY_MISTAKES.some(m => details.includes(m));
        const count = parseInt(mistake.mistake_count);

        if (count < 3 && !isHighSeverity) {
            return res.status(400).json({ success: false, error: "Threshold not met for IR issuance." });
        }

        const descriptionString = isHighSeverity 
            ? `Critical severity mistake (${details}) promoted to IR.` 
            : `Daily limit exceeded (${count} mistakes) promoted to IR.`;

        const insertQuery = `
            INSERT INTO incident_reports 
            (full_name, emp_no, incident_details, incident_date, description, admin_id, position, status, amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?)
        `;
        const insertValues = [
            mistake.full_name, String(mistake.emp_no).trim().toUpperCase(), mistake.incident_details,
            mistake.incident_date, descriptionString, String(adminId), mistake.position || 'General Staff', parseFloat(mistake.amount || 0)
        ];

        const [promoteResult] = await mysqlPool.query(insertQuery, insertValues);

        // Logging the promotional transformation chain
        const logQuery = `
            INSERT INTO other_logs (employee_id, employee_name, action, timestamp, description)
            VALUES (?, ?, 'IR Issued for Mistakes', ?, ?)
        `;
        const logValues = [
            String(adminId), adminName || "System", new Date().toISOString(), `Promoted mistake for ${mistake.full_name} (${mistake.emp_no}) to IR.`
        ];
        await mysqlPool.query(logQuery, logValues);

        return res.status(201).json({ 
            success: true, 
            data: { id: promoteResult.insertId, ...mistake, status: 'created' } 
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;