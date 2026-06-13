const express = require('express');
const router = express.Router();
const db = require('../db'); // Your working MySQL Client Pool configuration

/**
 * 🔐 AUTH MIDDLEWARE: User Role Verification
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const rawRole = req.headers['x-user-role'];
        if (!rawRole) return res.status(401).json({ success: false, message: "Unauthorized: No role provided." });
        
        const userRole = rawRole.trim().toUpperCase();
        const upperAllowed = allowedRoles.map(r => r.toUpperCase());

        if (!upperAllowed.includes(userRole)) {
            return res.status(403).json({ success: false, message: `Access Denied for ${userRole}.` });
        }
        next();
    };
};

/**
 * 🧮 HELPER: Calculate Annual and Casual Balances (Converted to MySQL)
 */
const calculateRemainingBalance = async (employee_id) => {
    // 1. Fetch limits directly from your checked employees schema layout
    const [empRows] = await db.execute(
        "SELECT annual_leave, casual_leave FROM employees WHERE employee_id = ? LIMIT 1",
        [employee_id]
    );
    
    if (empRows.length === 0) {
        return { annual_balance: 0, casual_balance: 0 };
    }
    const emp = empRows[0];

    // 2. Aggregate counts utilizing efficient native SQL processing
    const [leaveRows] = await db.execute(
        `SELECT leave_type, SUM(number_of_days) as total_days 
         FROM leave_applications 
         WHERE employee_id = ? AND status = 'Approved' 
         GROUP BY leave_type`,
        [employee_id]
    );

    let takenAnnual = 0;
    let takenCasual = 0;

    leaveRows.forEach(row => {
        const type = row.leave_type.toLowerCase();
        if (type === 'annual') takenAnnual = parseFloat(row.total_days) || 0;
        if (type === 'casual') takenCasual = parseFloat(row.total_days) || 0;
    });

    return {
        annual_balance: (emp.annual_leave || 0) - takenAnnual,
        casual_balance: (emp.casual_leave || 0) - takenCasual
    };
};

/**
 * 🚀 1. POST: Apply for Leave
 */
router.post('/apply', async (req, res) => {
    try {
        const { employee_id, employee_name, leave_type, start_date, end_date, number_of_days, reason, user_id } = req.body;
        const normalizedType = leave_type.toLowerCase();
        
        // Pick destination table targets exactly like your frontend components expect
        let targetTable = (normalizedType === 'annual' || normalizedType === 'casual') 
                        ? 'leave_applications' 
                        : 'leave_applications_two';

        const mysqlQuery = `
            INSERT INTO ${targetTable} 
            (employee_id, employee_name, leave_type, start_date, end_date, number_of_days, reason, user_id, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')
        `;
        
        const [result] = await db.execute(mysqlQuery, [
            employee_id || null, 
            employee_name || null, 
            leave_type || null, 
            start_date || null, 
            end_date || null, 
            number_of_days || 0, 
            reason || null, 
            user_id || null
        ]);

        // Construct mock response tracking block to map seamlessly with your client variables
        const fakeDataOutput = [{
            id: result.insertId,
            employee_id,
            employee_name,
            leave_type,
            start_date,
            end_date,
            number_of_days,
            reason,
            user_id,
            status: 'Pending',
            apply_date: new Date()
        }];

        res.status(201).json({ success: true, message: "Application submitted successfully!", leave: fakeDataOutput });

    } catch (err) {
        console.error("MySQL Insert Error:", err);
        res.status(500).json({ success: false, message: "Database Error: " + err.message });
    }
});

/**
 * ✅ 2. PATCH: Approve Leave
 */
router.patch('/approve/:id', authorize(['Super Admin', 'ER']), async (req, res) => {
    try {
        const { id } = req.params; 
        const { 
            status, 
            admin_id, 
            admin_name, 
            leave_type, 
            employee_id, 
            start_date 
        } = req.body;
        
        const normType = leave_type?.toLowerCase();
        const targetTable = (normType === 'medical' || normType === 'no pay') 
                            ? 'leave_applications_two' 
                            : 'leave_applications';

        const mysqlStatus = status || null;

        // 1. Update targeting specific unique application instance records
        await db.execute(
            `UPDATE ${targetTable} SET status = ? WHERE id = ?`, 
            [mysqlStatus, id]
        );

        // 2. Track activity inside log history table
        await db.execute(
            "INSERT INTO other_logs (employee_id, employee_name, action, description) VALUES (?, ?, ?, ?)",
            [
                admin_id || null,
                admin_name || null,
                `Leave ${mysqlStatus}`,
                `${leave_type} leave has been ${mysqlStatus}. (ID: ${id})`
            ]
        );

        res.json({ success: true, message: `Leave status updated to ${mysqlStatus}.` });
    } catch (err) {
        console.error("MySQL Update Error:", err.message);
        res.status(500).json({ success: false, message: "Sync Error: " + err.message });
    }
});

/**
 * 📄 3. GET: All leaves for a specific employee
 */
router.get('/my-leaves/:empId', async (req, res) => {
    try {
        const { empId } = req.params;

        // Parallel execution patterns parsing records out of both primary tables
        const [res1, res2] = await Promise.all([
            db.execute("SELECT * FROM leave_applications WHERE employee_id = ?", [empId]),
            db.execute("SELECT * FROM leave_applications_two WHERE employee_id = ?", [empId])
        ]);

        // Gather underlying structural data arrays from pool output envelopes
        const data1 = res1[0] || [];
        const data2 = res2[0] || [];

        const combined = [...data1, ...data2].sort((a, b) => {
            const dateA = a.apply_date || a.created_at;
            const dateB = b.apply_date || b.created_at;
            return new Date(dateB) - new Date(dateA);
        });

        res.json({ success: true, leaves: combined });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 👑 4. GET: All leave applications (Admin/ER Only)
 */
router.get('/all', authorize(['Super Admin', 'ER']), async (req, res) => {
    try {
        const [res1, res2] = await Promise.all([
            db.execute("SELECT * FROM leave_applications"),
            db.execute("SELECT * FROM leave_applications_two")
        ]);

        const data1 = res1[0] || [];
        const data2 = res2[0] || [];

        const allLeaves = [...data1, ...data2].sort((a, b) => {
            const dateA = a.apply_date || a.created_at;
            const dateB = b.apply_date || b.created_at;
            return new Date(dateB) - new Date(dateA);
        });

        res.json({ success: true, leaves: allLeaves });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 💰 5. GET: Get Leave Balance
 */
router.get('/balance/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const balances = await calculateRemainingBalance(empId);
        
        res.json({ 
            success: true, 
            annual: balances.annual_balance, 
            casual: balances.casual_balance 
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;