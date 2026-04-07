const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/**
 * Middleware: Role-Based Authorization
 * ලැබෙන Role එක සහ අවසර දී ඇති Role එක සසඳා බලා අවසර ලබා දෙයි.
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const rawRole = req.headers['x-user-role'];
        if (!rawRole) {
            return res.status(401).json({ success: false, message: "Unauthorized: No role provided." });
        }

        const userRole = rawRole.trim().toUpperCase();
        const normalizedAllowed = allowedRoles.map(r => r.toUpperCase());

        if (!normalizedAllowed.includes(userRole)) {
            return res.status(403).json({ success: false, message: `Forbidden: Access denied for ${userRole}.` });
        }
        
        req.normalizedRole = userRole;
        next();
    };
};

/**
 * 1. GET: Warning Statistics
 */
router.get('/stats', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP', 'Employees']), async (req, res) => {
    const userRole = req.normalizedRole;
    const employeeId = req.headers['x-employee-id'];

    try {
        let query = supabase.from('warnings').select('employee_id').eq('status', 'Approved');

        if (userRole === 'EMPLOYEES') {
            if (!employeeId) return res.status(400).json({ success: false, message: "Missing Employee ID" });
            query = query.eq('employee_id', employeeId);
        }

        const { data, error } = await query;
        if (error) throw error;

        const counts = {};
        let stats = { first: 0, second: 0, final: 0 };

        data.forEach(w => {
            counts[w.employee_id] = (counts[w.employee_id] || 0) + 1;
            const currentCount = counts[w.employee_id];
            
            if (currentCount === 1) stats.first++;
            else if (currentCount === 2) stats.second++;
            else if (currentCount >= 3) stats.final++;
        });

        res.json({ success: true, ...stats });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * 2. POST: Issue New Warning
 */
router.post('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    const { 
        admin_id, admin_name, employee_id, reason, 
        sub_reason, warning_date, explanation, supervisor_comments 
    } = req.body;
    const userRole = req.normalizedRole;

    try {
        const status = (userRole === 'ER') ? 'Pending' : 'Approved';

        const { data, error } = await supabase
            .from('warnings')
            .insert([{ 
                employee_id, 
                reason, 
                sub_reason: sub_reason || null, 
                warning_date, 
                explanation, 
                supervisor_comments,
                status,
                issued_by: admin_name 
            }])
            .select()
            .single();

        if (error) throw error;

        await supabase.from('other_logs').insert({
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Warning Created",
            description: `Warning issued to ${employee_id}. Status: ${status}`
        });

        res.status(201).json({ success: true, message: "Success", data });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

/**
 * 3. PATCH: Approve Warning
 */
router.patch('/approve/:id', authorize(['Super Admin', 'Supervisors', 'Admin']), async (req, res) => {
    const { id } = req.params;
    const { admin_id, admin_name } = req.body; 

    try {
        const { data: updatedWarning, error: updateError } = await supabase
            .from('warnings')
            .update({ status: 'Approved', approved_by: admin_name })
            .eq('id', id)
            .eq('status', 'Pending') 
            .select()
            .single();

        if (updateError || !updatedWarning) {
            return res.status(404).json({ success: false, message: "Warning not found or already approved." });
        }

        await supabase.from('other_logs').insert({
            employee_id: admin_id || "System",
            employee_name: admin_name || "Supervisor",
            action: "Warning Approved",
            description: `Warning ID ${id} approved by ${admin_name}.`
        });

        res.json({ success: true, message: "Warning approved successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * 4. PATCH: Update Warning (Edit)
 * Admin හෝ Supervisors හට පමණක් සංස්කරණය කළ හැක.
 */
router.patch('/:id', authorize(['Super Admin', 'Admin', 'Supervisors']), async (req, res) => {
    const { id } = req.params;
    const { reason, sub_reason, explanation, warning_date, admin_id, admin_name } = req.body;

    try {
        const { data, error } = await supabase
            .from('warnings')
            .update({
                reason,
                sub_reason,
                explanation,
                warning_date
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        await supabase.from('other_logs').insert({
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Warning Updated",
            description: `Warning ID ${id} was modified.`
        });

        res.json({ success: true, message: "Warning updated successfully", data });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

/**
 * 5. DELETE: Remove Warning
 * Super Admin සහ Admin හට පමණක් මැකිය හැක.
 */
router.delete('/:id', authorize(['Super Admin', 'Admin']), async (req, res) => {
    const { id } = req.params;
    const adminId = req.headers['x-employee-id'];

    try {
        const { error } = await supabase
            .from('warnings')
            .delete()
            .eq('id', id);

        if (error) throw error;

        await supabase.from('other_logs').insert({
            employee_id: adminId || "System",
            action: "Warning Deleted",
            description: `Warning ID ${id} was permanently deleted.`
        });

        res.json({ success: true, message: "Warning deleted successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * 6. GET: Employee Search for Autofill
 */
router.get('/employees/search/:id', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('employees')
            .select('full_name')
            .eq('employee_id', id)
            .single();

        if (error || !data) return res.json({ success: false, message: "Not found" });
        res.json({ success: true, name: data.full_name });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 7. GET: All Warnings
 */
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP', 'Employees']), async (req, res) => {
    const userRole = req.normalizedRole;
    const employeeId = req.headers['x-employee-id'];

    try {
        let query = supabase.from('warnings').select('*').order('created_at', { ascending: false });

        if (userRole === 'EMPLOYEES') {
            if (!employeeId) return res.status(400).json({ success: false, message: "Employee ID missing" });
            query = query.eq('employee_id', employeeId).eq('status', 'Approved'); 
        }

        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, warnings: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;