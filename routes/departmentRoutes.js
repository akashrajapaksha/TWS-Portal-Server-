const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/**
 * AUTH MIDDLEWARE
 * Enforces the permissions from your hierarchy spreadsheet.
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const userRole = req.headers['x-user-role'];
        if (!userRole) {
            return res.status(401).json({ success: false, message: "Unauthorized: No role provided." });
        }
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: `Access Denied: ${userRole} cannot perform this action.` });
        }
        next();
    };
};

/**
 * HELPER: Clean Incoming Data
 * Fixes the "invalid input syntax" for dates and numbers.
 */
const sanitizeDepartmentData = (data) => {
    const cleaned = { ...data };
    
    // Convert empty date strings to null so Postgres doesn't crash
    const dateFields = ['created_date']; 
    dateFields.forEach(field => {
        if (cleaned[field] === "") cleaned[field] = null;
    });

    // Ensure employees_count is always a valid integer
    if (cleaned.employees_count === "" || cleaned.employees_count === undefined) {
        cleaned.employees_count = 0;
    } else {
        cleaned.employees_count = parseInt(cleaned.employees_count) || 0;
    }

    return cleaned;
};

// 1. GET: Fetch all departments
// PERMISSION: Super Admin, Supervisors, ER, Admin, TSP
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('departments')
            .select('*')
            .order('name', { ascending: true });

        if (error) throw error;
        res.json({ success: true, departments: data });
    } catch (err) {
        console.error("❌ Fetch Error:", err.message);
        res.status(500).json({ success: false, message: "Could not fetch departments." });
    }
});

// 2. POST: Add new department
// PERMISSION: Super Admin, Supervisors, ER, Admin (Creation and update only)
router.post('/add', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    try {
        const { name, status, employee_id, employee_name } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, message: "Department name is required." });
        }

        const insertData = sanitizeDepartmentData({
            name: name.trim(),
            status: status || 'Active',
            employees_count: 0
        });

        const { data: deptData, error: deptError } = await supabase
            .from('departments')
            .insert([insertData])
            .select();

        if (deptError) throw deptError;

        // Log action in English
        await supabase.from('other_logs').insert([{
            employee_id: employee_id || "System",
            employee_name: employee_name || "Admin",
            action: "Department Added",
            timestamp: new Date().toISOString(),
            description: `New department '${name}' was successfully created.`
        }]);

        res.status(201).json({ success: true, department: deptData[0] });
    } catch (err) {
        console.error("❌ Add Error:", err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

// 3. PUT: Update department
// PERMISSION: Super Admin, Supervisors, ER, Admin (Creation and update only)
router.put('/:id', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, status, employee_id, employee_name, ...otherData } = req.body;

        const updateData = sanitizeDepartmentData({ name, status, ...otherData });

        const { data: deptData, error: deptError } = await supabase
            .from('departments')
            .update(updateData)
            .eq('id', id)
            .select();

        if (deptError) throw deptError;

        // Log action in English
        await supabase.from('other_logs').insert([{
            employee_id: employee_id || "System",
            employee_name: employee_name || "Admin",
            action: "Department Updated",
            timestamp: new Date().toISOString(),
            description: `Department '${name}' was updated to status: ${status}.`
        }]);

        res.json({ success: true, department: deptData[0] });
    } catch (err) {
        console.error("❌ Update Error:", err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

// 4. DELETE: Remove department
// PERMISSION: Super Admin, Supervisors, ER (Admin is excluded from delete)
router.delete('/:id', authorize(['Super Admin', 'Supervisors', 'ER']), async (req, res) => {
    try {
        const { id } = req.params;
        const { employee_id, employee_name, dept_name } = req.query;
        
        if (!id) return res.status(400).json({ success: false, message: "ID is required." });

        const { error: deleteError } = await supabase
            .from('departments')
            .delete()
            .eq('id', id);

        if (deleteError) throw deleteError;

        // Log action in English
        await supabase.from('other_logs').insert([{
            employee_id: employee_id || "System",
            employee_name: employee_name || "Admin",
            action: "Department Deleted",
            timestamp: new Date().toISOString(),
            description: `Department '${dept_name || id}' was permanently removed.`
        }]);

        res.json({ success: true, message: "Department deleted successfully." });
    } catch (err) {
        console.error("❌ Delete Error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;