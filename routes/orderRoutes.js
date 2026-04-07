const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/**
 * Middleware: Role-Based Access Control (RBAC)
 * Strictly enforces that 'x-user-role' is present and allowed.
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const userRole = req.headers['x-user-role'];
        if (!userRole) return res.status(401).json({ success: false, message: "Unauthorized: Missing Role" });
        
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: `Access Denied for ${userRole}` });
        }
        next();
    };
};

// 0. GET: Employee ID Lookup (Used for auto-filling form names)
router.get('/fetch-by-id/:id', async (req, res) => {
    try {
        const cleanId = req.params.id.trim().toUpperCase();

        const { data, error } = await supabase
            .from('employees')
            .select('name, designation, project')
            .eq('employee_id', cleanId)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        res.json({
            success: true,
            name: data.name,
            designation: data.designation,
            project: data.project
        });
    } catch (err) {
        res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

// 1. GET: Fetch all performance records (Sorted by most recent)
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP', 'LD']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .order('date', { ascending: false });

        if (error) throw error;
        res.json({ success: true, orders: data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. POST: Add new performance record + Audit Log
router.post('/add', authorize(['Super Admin', 'Supervisors', 'TSP', 'LD']), async (req, res) => {
    try {
        const { 
            employee_id, employee_name, project, 
            employee_position, date, shift, 
            order_count, admin_id, admin_name 
        } = req.body;

        // Step A: Insert Performance Record
        const { data, error } = await supabase
            .from('orders')
            .insert([{
                employee_id: employee_id.trim().toUpperCase(),
                employee_name,
                project,
                employee_position,
                date,
                shift,
                order_count: parseInt(order_count) || 0
            }])
            .select();

        if (error) throw error;

        // Step B: Audit Logging
        await supabase.from('other_logs').insert([{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Performance Added",
            timestamp: new Date().toISOString(),
            description: `Performance (Count: ${order_count}) logged for ${employee_name} by ${admin_name}.`
        }]);

        res.status(201).json({ success: true, order: data[0] });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// 3. PUT: Update existing record + Audit Log
router.put('/:id', authorize(['Super Admin', 'Supervisors', 'TSP', 'LD']), async (req, res) => {
    try {
        const { 
            employee_id, employee_name, project, 
            employee_position, date, shift, 
            order_count, admin_id, admin_name 
        } = req.body;

        // Step A: Update Record
        const { data, error } = await supabase
            .from('orders')
            .update({
                employee_id: employee_id.trim().toUpperCase(),
                employee_name,
                project,
                employee_position,
                date,
                shift,
                order_count: parseInt(order_count) || 0
            })
            .eq('id', req.params.id)
            .select();

        if (error) throw error;

        // Step B: Audit Logging
        await supabase.from('other_logs').insert([{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Performance Updated",
            timestamp: new Date().toISOString(),
            description: `Performance record for ${employee_name} was modified by ${admin_name}.`
        }]);

        res.json({ success: true, order: data[0] });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// 4. DELETE: Remove record + Audit Log
router.delete('/:id', authorize(['Super Admin', 'Supervisors', 'TSP']), async (req, res) => {
    try {
        const { admin_id, admin_name, emp_name } = req.query;

        // Step A: Delete from Orders
        const { error } = await supabase
            .from('orders')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;

        // Step B: Audit Logging
        await supabase.from('other_logs').insert([{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Performance Deleted",
            timestamp: new Date().toISOString(),
            description: `Performance log for ${emp_name} was permanently deleted by ${admin_name}.`
        }]);

        res.json({ success: true, message: "Deleted successfully" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;