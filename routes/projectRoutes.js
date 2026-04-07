const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/**
 * AUTH MIDDLEWARE
 * Enforces permissions:
 * - View: Super Admin, Supervisors, ER, Admin, TSP, Employees
 * - Create/Update: Super Admin, Supervisors, ER, Admin
 * - Delete: Super Admin, Supervisors, ER
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

// 1. GET: Fetch all projects
// PERMISSION: All internal roles (Employees need this to see bonus rules)
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TSP', 'Employees']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('projects')
            .select('*')
            .order('id', { ascending: false });

        if (error) throw error;

        /**
         * Returning raw data array directly. 
         * This ensures BonusCalculation.tsx can use data.map() immediately.
         */
        res.json(data || []);
    } catch (err) {
        console.error("❌ Fetch Error:", err.message);
        res.status(500).json({ success: false, message: "Could not fetch projects." });
    }
});

// 2. POST: Create a new project
// PERMISSION: Super Admin, Supervisors, ER, Admin
router.post('/add', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    try {
        const { name, client, status, deadline, employee_id, employee_name } = req.body;
        
        // Sanitize date to prevent Postgres syntax errors
        const cleanDeadline = deadline === "" ? null : deadline;

        const { data, error } = await supabase
            .from('projects')
            .insert([{ 
                name, 
                client, 
                status, 
                deadline: cleanDeadline,
                bonus_tiers: [] // Initialize with empty array for JSONB
            }])
            .select();

        if (error) throw error;

        // --- Audit Log ---
        await supabase.from('other_logs').insert([{
            employee_id: employee_id || "System",
            employee_name: employee_name || "Admin",
            action: "Project Created",
            timestamp: new Date().toISOString(),
            description: `A new project '${name}' was created for client '${client}'.`
        }]);

        res.status(201).json({ success: true, project: data[0] });
    } catch (err) {
        console.error("❌ Add Error:", err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

// 3. PUT: Update an existing project (Includes Bonus Tiers)
// PERMISSION: Super Admin, Supervisors, ER, Admin
router.put('/:id', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, client, status, deadline, bonus_tiers, employee_id, employee_name } = req.body;
        
        const cleanDeadline = deadline === "" ? null : deadline;

        const { data, error } = await supabase
            .from('projects')
            .update({ 
                name, 
                client, 
                status, 
                deadline: cleanDeadline,
                bonus_tiers: bonus_tiers || [] // Support for dynamic bonus configuration
            })
            .eq('id', id)
            .select();

        if (error) throw error;

        // --- Audit Log ---
        await supabase.from('other_logs').insert([{
            employee_id: employee_id || "System",
            employee_name: employee_name || "Admin",
            action: "Project Updated",
            timestamp: new Date().toISOString(),
            description: `Project '${name}' was updated. Bonus tiers or settings modified.`
        }]);

        res.json({ success: true, project: data[0] });
    } catch (err) {
        console.error("❌ Update Error:", err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

// 4. DELETE: Permanently remove a project
// PERMISSION: Super Admin, Supervisors, ER
router.delete('/:id', authorize(['Super Admin', 'Supervisors', 'ER']), async (req, res) => {
    try {
        const { id } = req.params;
        const { employee_id, employee_name, project_name } = req.query;

        const { error } = await supabase
            .from('projects')
            .delete()
            .eq('id', id);
            
        if (error) throw error;

        // --- Audit Log ---
        await supabase.from('other_logs').insert([{
            employee_id: employee_id || "System",
            employee_name: employee_name || "Admin",
            action: "Project Deleted",
            timestamp: new Date().toISOString(),
            description: `Project '${project_name || id}' was permanently removed from the system.`
        }]);

        res.json({ success: true, message: "Project deleted successfully" });
    } catch (err) {
        console.error("❌ Delete Error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;