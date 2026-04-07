const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/** --- CONSTANTS --- **/
const ROLE_HIERARCHY = {
    'SUPER ADMIN': 7,
    'SUPERVISORS': 6,
    'ER': 5,
    'ADMIN': 4,
    'TPS': 3,
    'LD': 2,
    'EMPLOYEES': 1
};

/**
 * NEW CONSTANT: Define safe fields to return to the frontend.
 * This ensures passwords and 2FA secrets never leave the server.
 */
const SAFE_FIELDS = 'id, employee_id, name, initials, phone_number, email, department, project, designation, status, gender, dob, date_of_joining, address, annual_leave, casual_leave, created_at, role, is_first_login';

/**
 * HELPER: Clean Incoming Data
 */
const sanitizeEmployeeData = (data) => {
    const cleaned = { ...data };
    const dateFields = ['dob', 'date_of_joining'];
    dateFields.forEach(field => {
        if (cleaned[field] === "" || cleaned[field] === undefined) cleaned[field] = null;
    });

    const numFields = ['annual_leave', 'casual_leave'];
    numFields.forEach(field => {
        if (cleaned[field] !== undefined) {
            cleaned[field] = parseInt(cleaned[field]) || 0;
        }
    });

    delete cleaned.admin_id;
    delete cleaned.admin_name;

    return cleaned;
};

/**
 * AUTH MIDDLEWARE
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const rawRole = req.headers['x-user-role'];
        if (!rawRole) return res.status(401).json({ success: false, message: "Unauthorized: No role provided." });
        
        const userRole = rawRole.trim().toUpperCase();
        const upperAllowed = allowedRoles.map(r => r.toUpperCase());

        if (!upperAllowed.includes(userRole)) {
            return res.status(403).json({ success: false, message: `Forbidden: Access denied for ${userRole}.` });
        }
        next();
    };
};

/** --- PUBLIC ROUTES --- **/

/**
 * 1. GET: Public Name Search
 */
router.get('/public-search/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const { data, error } = await supabase
            .from('employees')
            .select('name')
            .ilike('employee_id', empId.trim()) 
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "ID not found" });

        res.json({ success: true, name: data.name });
    } catch (err) {
        console.error("Public Search Error:", err.message);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

/** --- PROTECTED ROUTES --- **/

/**
 * 2. GET: Fetch All Employees (FIXED: Uses SAFE_FIELDS)
 */
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TPS']), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('employees')
            .select(SAFE_FIELDS) // Removed '*' to hide passwords
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, employees: data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 3. POST: Add Employee (FIXED: Selects safe fields for response)
 */
router.post('/add', authorize(['Super Admin', 'Admin']), async (req, res) => {
    try {
        const creatorRole = req.headers['x-user-role']?.trim().toUpperCase();
        const { admin_id, admin_name, password, ...rawEmployeeData } = req.body;
        
        if (!password || password.trim() === "") {
            return res.status(400).json({ success: false, message: "Password is required for new employees." });
        }

        const employeeData = sanitizeEmployeeData(rawEmployeeData);
        const targetRole = (employeeData.role || 'Employees').toUpperCase();

        if (creatorRole !== 'SUPER ADMIN') {
            if (creatorRole === 'ADMIN') {
                if (targetRole !== 'EMPLOYEES') {
                    return res.status(403).json({ 
                        success: false, 
                        message: "Access Denied: Admins are only authorized to create standard 'Employees'." 
                    });
                }
            } else {
                return res.status(403).json({ success: false, message: "Access Denied: Role unauthorized for creation." });
            }
        }

        employeeData.password = password.trim(); 
        employeeData.is_first_login = true; 

        const { data, error } = await supabase
            .from('employees')
            .insert([employeeData])
            .select(SAFE_FIELDS) // Ensures password isn't in the confirmation response
            .single();

        if (error) {
            if (error.code === '23505') return res.status(400).json({ success: false, message: "ID or Email already exists." });
            throw error;
        }

        await supabase.from('other_logs').insert({
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Employee Added",
            timestamp: new Date().toISOString(),
            description: `New employee '${employeeData.name}' (${employeeData.role}) added by ${admin_name}.`
        });

        res.status(201).json({ success: true, message: "Employee added successfully!", employee: data });
    } catch (err) {
        console.error("Add Employee Error:", err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

/**
 * 4. PATCH: Update Own Password
 */
router.patch('/change-password', async (req, res) => {
    try {
        const { employee_id, currentPassword, newPassword } = req.body;

        if (!employee_id || !currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: "All fields are required." });
        }

        const { data: user, error: fetchError } = await supabase
            .from('employees')
            .select('id, password')
            .eq('employee_id', employee_id)
            .single();

        if (fetchError || !user) return res.status(404).json({ success: false, message: "Employee not found." });

        if (user.password !== currentPassword.trim()) {
            return res.status(401).json({ success: false, message: "Current password incorrect." });
        }

        const { error: updateError } = await supabase
            .from('employees')
            .update({ 
                password: newPassword.trim(),
                is_first_login: false 
            })
            .eq('id', user.id);

        if (updateError) throw updateError;

        res.json({ success: true, message: "Password updated successfully." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 5. PUT: Update Employee Profile
 */
router.put('/:id', authorize(['Super Admin', 'Admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const editorRole = req.headers['x-user-role']?.trim().toUpperCase();
        const { admin_id, admin_name, ...rawUpdateData } = req.body;

        const updateData = sanitizeEmployeeData(rawUpdateData);

        const { data: targetUser, error: fetchError } = await supabase
            .from('employees')
            .select('role, name')
            .eq('id', id)
            .single();

        if (fetchError || !targetUser) return res.status(404).json({ success: false, message: "Target employee not found." });

        const currentTargetRole = targetUser.role.toUpperCase();

        if (editorRole !== 'SUPER ADMIN') {
            if (editorRole === 'ADMIN') {
                if (currentTargetRole !== 'EMPLOYEES') {
                    return res.status(403).json({ success: false, message: "Access Denied: Admins can only modify 'Employees'." });
                }
                if (updateData.role && updateData.role.toUpperCase() !== 'EMPLOYEES') {
                    return res.status(403).json({ success: false, message: "Access Denied: Admins cannot assign management roles." });
                }
            } else {
                return res.status(403).json({ success: false, message: "Access Denied: Unauthorized." });
            }
        }

        const { error } = await supabase
            .from('employees')
            .update(updateData)
            .eq('id', id);

        if (error) throw error;

        await supabase.from('other_logs').insert({
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Employee Updated",
            timestamp: new Date().toISOString(),
            description: `Profile of '${targetUser.name}' updated by ${admin_name}.`
        });

        res.json({ success: true, message: "Employee updated successfully" });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

/**
 * 6. DELETE: Remove Employee
 */
router.delete('/:id', authorize(['Super Admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_id, admin_name, emp_name } = req.query;

        const { error } = await supabase.from('employees').delete().eq('id', id);
        if (error) throw error;

        await supabase.from('other_logs').insert({
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Employee Deleted",
            timestamp: new Date().toISOString(),
            description: `Employee '${emp_name}' removed by ${admin_name}.`
        });

        res.json({ success: true, message: "Employee deleted successfully" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 7. GET: Protected Search (FIXED: Only selects name)
 */
router.get('/search/:empId', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TPS']), async (req, res) => {
    try {
        const { empId } = req.params;
        const { data, error } = await supabase
            .from('employees')
            .select('name')
            .ilike('employee_id', empId.trim())
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Employee not found." });

        res.json({ success: true, name: data.name });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;