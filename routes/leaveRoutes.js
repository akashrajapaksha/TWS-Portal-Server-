const express = require('express');
const router = express.Router();
const db = require('../mysqlClient'); // MySQL Client Pool
const supabase = require('../supabaseClient'); // Supabase Client

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
 * 🧮 HELPER: Calculate Annual and Casual Balances (Supabase Only)
 */
const calculateRemainingBalance = async (employee_id) => {
    const { data: emp } = await supabase
        .from('employees')
        .select('annual_leave, casual_leave')
        .eq('id', employee_id)
        .single();

    const { data: approvedLeaves } = await supabase
        .from('leave_applications')
        .select('leave_type, number_of_days')
        .eq('employee_id', employee_id)
        .eq('status', 'Approved');

    let takenAnnual = 0;
    let takenCasual = 0;

    if (approvedLeaves) {
        approvedLeaves.forEach(leave => {
            const type = leave.leave_type.toLowerCase();
            if (type === 'annual') takenAnnual += leave.number_of_days;
            if (type === 'casual') takenCasual += leave.number_of_days;
        });
    }

    return {
        annual_balance: (emp?.annual_leave || 0) - takenAnnual,
        casual_balance: (emp?.casual_leave || 0) - takenCasual
    };
};

/**
 * 🚀 1. POST: Apply for Leave
 */
router.post('/apply', async (req, res) => {
    try {
        const { employee_id, employee_name, leave_type, start_date, end_date, number_of_days, reason, user_id } = req.body;
        const normalizedType = leave_type.toLowerCase();
        let targetTable = (normalizedType === 'annual' || normalizedType === 'casual') 
                          ? 'leave_applications' 
                          : 'leave_applications_two';

        // 1. MySQL Insert
        const mysqlQuery = `INSERT INTO ${targetTable} 
            (employee_id, employee_name, leave_type, start_date, end_date, number_of_days, reason, user_id, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`;
        
        await db.execute(mysqlQuery, [
            employee_id || null, 
            employee_name || null, 
            leave_type || null, 
            start_date || null, 
            end_date || null, 
            number_of_days || 0, 
            reason || null, 
            user_id || null
        ]);

        // 2. Supabase Insert
        const { data, error } = await supabase
            .from(targetTable)
            .insert([{
                employee_id, employee_name, leave_type, start_date, 
                end_date, number_of_days, reason, user_id, status: 'Pending'
            }])
            .select();

        if (error) throw error;

        res.status(201).json({ success: true, message: "Application submitted successfully!", leave: data });

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

        // Fix to prevent undefined parameters
        const mysqlStatus = status || null;
        const mysqlEmpId = employee_id || null;
        const mysqlStartDate = start_date || null;

        // 1. MySQL Update
        await db.execute(
            `UPDATE ${targetTable} SET status = ? WHERE employee_id = ? AND start_date = ?`, 
            [mysqlStatus, mysqlEmpId, mysqlStartDate]
        );

        // 2. Supabase Update (Using primary ID)
        const { error: updateErr } = await supabase
            .from(targetTable)
            .update({ status: mysqlStatus })
            .eq('id', id);

        if (updateErr) throw updateErr;

        // 3. Logs (Supabase ONLY)
        await supabase.from('other_logs').insert({
            employee_id: admin_id || null,
            employee_name: admin_name || null,
            action: `Leave ${mysqlStatus}`,
            description: `${leave_type} leave has been ${mysqlStatus}. (ID: ${id})`
        });

        res.json({ success: true, message: `Leave status updated to ${mysqlStatus}.` });
    } catch (err) {
        console.error("MySQL Update Error:", err.message);
        res.status(500).json({ success: false, message: "Sync Error: " + err.message });
    }
});

/**
 * 📄 3. GET: All leaves for a specific employee (Supabase Only)
 */
router.get('/my-leaves/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const [res1, res2] = await Promise.all([
            supabase.from('leave_applications').select('*').eq('employee_id', empId),
            supabase.from('leave_applications_two').select('*').eq('employee_id', empId)
        ]);

        if (res1.error) throw res1.error;
        if (res2.error) throw res2.error;

        const combined = [...res1.data, ...res2.data].sort((a, b) => 
            new Date(b.apply_date) - new Date(a.apply_date)
        );

        res.json({ success: true, leaves: combined });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 👑 4. GET: All leave applications (Admin/ER Only - Supabase Only)
 */
router.get('/all', authorize(['Super Admin', 'ER']), async (req, res) => {
    try {
        const [res1, res2] = await Promise.all([
            supabase.from('leave_applications').select('*'),
            supabase.from('leave_applications_two').select('*')
        ]);

        const allLeaves = [...(res1.data || []), ...(res2.data || [])].sort((a, b) => 
            new Date(b.apply_date) - new Date(a.apply_date)
        );

        res.json({ success: true, leaves: allLeaves });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 💰 5. GET: Get Leave Balance (Supabase Only)
 */
router.get('/balance/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const balances = await calculateRemainingBalance(empId);
        res.json({ success: true, annual: balances.annual_balance, casual: balances.casual_balance });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;