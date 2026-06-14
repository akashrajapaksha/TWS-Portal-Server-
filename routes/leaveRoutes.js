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
 * 🧮 HELPER: Calculate Annual and Casual Balances (Aligned with Exact Schema)
 */
const calculateRemainingBalance = async (employee_id) => {
    // 1. Fetch base limits using your exact columns: annual_leave, casual_leave
    // Checking against your structural text column 'employee_id'
    const [empRows] = await db.execute(
        "SELECT annual_leave, casual_leave FROM employees WHERE employee_id = ? LIMIT 1",
        [employee_id]
    );
    
    if (!empRows || empRows.length === 0) {
        console.log(`[Balance Check] No employee found matching ID: ${employee_id}`);
        return { annual_balance: 0, casual_balance: 0 };
    }
    const emp = empRows[0];

    // 2. Fetch approved days from BOTH tables in parallel
    const [res1, res2] = await Promise.all([
        db.execute(
            `SELECT leave_type, SUM(number_of_days) as total_days 
             FROM leave_applications 
             WHERE employee_id = ? AND status = 'Approved' 
             GROUP BY leave_type`,
            [employee_id]
        ),
        db.execute(
            `SELECT leave_type, SUM(number_of_days) as total_days 
             FROM leave_applications_two 
             WHERE employee_id = ? AND status = 'Approved' 
             GROUP BY leave_type`,
            [employee_id]
        )
    ]);

    const leaveRows1 = res1[0] || [];
    const leaveRows2 = res2[0] || [];
    const allLeaveRows = [...leaveRows1, ...leaveRows2];

    let takenAnnual = 0;
    let takenCasual = 0;

    // Process all aggregated rows dynamically
    allLeaveRows.forEach(row => {
        if (!row.leave_type) return;
        const type = row.leave_type.toLowerCase().trim();
        if (type === 'annual') takenAnnual += parseFloat(row.total_days) || 0;
        if (type === 'casual') takenCasual += parseFloat(row.total_days) || 0;
    });

    // 3. Return remaining balances safely
    return {
        annual_balance: Math.max(0, (emp.annual_leave || 0) - takenAnnual),
        casual_balance: Math.max(0, (emp.casual_leave || 0) - takenCasual)
    };
};

/**
 * 🚀 1. POST: Apply for Leave
 */
router.post('/apply', async (req, res) => {
    try {
        const { employee_id, employee_name, leave_type, start_date, end_date, number_of_days, reason, user_id } = req.body;
        if (!leave_type) return res.status(400).json({ success: false, message: "Leave type is required." });
        
        const normalizedType = leave_type.toLowerCase().trim();
        
        // Split destinations based on target rules
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

        const dataOutput = [{
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

        res.status(201).json({ success: true, message: "Application submitted successfully!", leave: dataOutput });

    } catch (err) {
        console.error("MySQL Insert Error:", err);
        res.status(500).json({ success: false, message: "Database Error: " + err.message });
    }
});

/**
 * ✅ 2. PATCH: Approve or Reject Leave
 */
router.patch('/approve/:id', authorize(['Super Admin', 'ER']), async (req, res) => {
    try {
        const { id } = req.params; 
        const { status, admin_id, admin_name, leave_type } = req.body;
        
        if (!leave_type) return res.status(400).json({ success: false, message: "Leave type is required to update status." });
        
        const normType = leave_type.toLowerCase().trim();
        const targetTable = (normType === 'medical' || normType === 'no pay') 
                            ? 'leave_applications_two' 
                            : 'leave_applications';

        const mysqlStatus = status || 'Pending';

        // 1. Update the correct application table
        await db.execute(
            `UPDATE ${targetTable} SET status = ? WHERE id = ?`, 
            [mysqlStatus, id]
        );

        // 2. Insert trace record inside logs
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
 * 📄 3. GET: All leaves for a specific employee (Sorted newest first)
 */
router.get('/my-leaves/:empId', async (req, res) => {
    try {
        const { empId } = req.params;

        const [res1, res2] = await Promise.all([
            db.execute("SELECT * FROM leave_applications WHERE employee_id = ? ORDER BY id DESC", [empId]),
            db.execute("SELECT * FROM leave_applications_two WHERE employee_id = ? ORDER BY id DESC", [empId])
        ]);

        const data1 = res1[0] || [];
        const data2 = res2[0] || [];

        // Merge arrays and cleanly sort across fallback date properties
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
 * 👑 4. GET: All leave applications (Admin/ER View)
 */
router.get('/all', authorize(['Super Admin', 'ER']), async (req, res) => {
    try {
        const [res1, res2] = await Promise.all([
            db.execute("SELECT * FROM leave_applications ORDER BY id DESC"),
            db.execute("SELECT * FROM leave_applications_two ORDER BY id DESC")
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
 * 💰 5. GET: Get Clean Leave Balance Calculations
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


router.get('/balance/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        
        // 🔴 ADD THIS LOG TO YOUR TERMINAL:
        console.log("--> Backend received balance request for empId:", empId, "Type:", typeof empId);

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