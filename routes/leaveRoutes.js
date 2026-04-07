const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/**
 * 🔐 AUTH MIDDLEWARE: පරිශීලක අවසර පරීක්ෂාව
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
 * 🧮 HELPER: Annual සහ Casual ශේෂය ගණනය කිරීම
 */
const calculateRemainingBalance = async (employee_id) => {
    // සේවකයාට හිමි මුළු නිවාඩු (Annual & Casual)
    const { data: emp } = await supabase
        .from('employees')
        .select('annual_leave, casual_leave')
        .eq('id', employee_id)
        .single();

    // Table 1 වෙතින් අනුමත වූ නිවාඩු පමණක් ලබා ගැනීම
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
 * 🚀 1. POST: නිවාඩු අයදුම් කිරීම
 */
router.post('/apply', async (req, res) => {
    try {
        const { employee_id, employee_name, leave_type, start_date, end_date, number_of_days, reason, user_id } = req.body;
        const normalizedType = leave_type.toLowerCase();

        let targetTable = '';

        // --- වගුව තෝරාගැනීමේ Logic එක ---
        if (normalizedType === 'annual' || normalizedType === 'casual') {
            targetTable = 'leave_applications'; // පළමු වගුව
            
            // ශේෂය පරීක්ෂා කිරීම
            const balances = await calculateRemainingBalance(employee_id);
            const currentBalance = normalizedType === 'annual' ? balances.annual_balance : balances.casual_balance;

            if (currentBalance < number_of_days) {
                return res.status(400).json({ 
                    success: false, 
                    message: `ප්‍රමාණවත් ${leave_type} නිවාඩු ශේෂයක් නොමැත. (ඉතිරි: ${currentBalance})` 
                });
            }
        } else {
            targetTable = 'leave_applications_two'; // දෙවන වගුව (Medical/No Pay)
        }

        const { data, error } = await supabase
            .from(targetTable)
            .insert([{
                employee_id,
                employee_name,
                leave_type,
                start_date,
                end_date,
                number_of_days,
                reason,
                user_id,
                status: 'Pending'
            }])
            .select();

        if (error) throw error;
        res.status(201).json({ success: true, message: "අයදුම්පත සාර්ථකව යොමු කරන ලදී!", leave: data });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 📄 2. GET: සේවකයාගේ සියලුම නිවාඩු (වගු දෙකෙන්ම)
 */
router.get('/my-leaves/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        
        // Parallel fetching for performance
        const [res1, res2] = await Promise.all([
            supabase.from('leave_applications').select('*').eq('employee_id', empId),
            supabase.from('leave_applications_two').select('*').eq('employee_id', empId)
        ]);

        if (res1.error) throw res1.error;
        if (res2.error) throw res2.error;

        // දත්ත දෙකම එකතු කර දිනය අනුව පිළිවෙලට සකස් කිරීම
        const combined = [...res1.data, ...res2.data].sort((a, b) => 
            new Date(b.apply_date) - new Date(a.apply_date)
        );

        res.json({ success: true, leaves: combined });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 👑 3. GET: සියලුම නිවාඩු අයදුම්පත් (Admin/ER සඳහා)
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
 * ✅ 4. PATCH: නිවාඩු අනුමත කිරීම (Status Update)
 */
router.patch('/approve/:id', authorize(['Super Admin', 'ER']), async (req, res) => {
    try {
        const { id } = req.params;
        const { status, admin_id, admin_name, leave_type } = req.body;
        
        const normType = leave_type?.toLowerCase();
        const targetTable = (normType === 'medical' || normType === 'no pay') 
                            ? 'leave_applications_two' 
                            : 'leave_applications';

        const { error: updateErr } = await supabase
            .from(targetTable)
            .update({ status: status })
            .eq('id', id);

        if (updateErr) throw updateErr;

        // Log record insert (Optional)
        await supabase.from('other_logs').insert({
            employee_id: admin_id,
            employee_name: admin_name,
            action: `Leave ${status}`,
            description: `${leave_type} නිවාඩුවක් ${status} කරන ලදී. (ID: ${id})`
        });

        res.json({ success: true, message: `නිවාඩුව ${status} කරන ලදී.` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 💰 5. GET: නිවාඩු ශේෂය ලබා ගැනීම
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