const express = require('express');
const router = express.Router();
const db = require('../db'); // ✅ Import your initialized mysql2 pool
const multer = require('multer');
const path = require('path');

/** --- MULTER CONFIGURATION FOR IMAGE UPLOADS --- **/
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/'); // Saves files to an 'uploads' folder in your root directory
    },
    filename: (req, file, cb) => {
        // Appends timestamp to the original filename to ensure uniqueness
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

// File filter to ensure only image assets are sent
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed!'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // Optional limit: 5MB max
});


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

// ✅ Selective safe database field list setup
const SAFE_FIELDS = 'id, employee_id, name, initials, email, department, project, designation, status, date_of_joining, annual_leave, casual_leave, created_at, role, is_first_login, profile_image, two_factor_secret';

/**
 * HELPER: Clean Incoming Data
 */
const sanitizeEmployeeData = (data) => {
    const cleaned = { ...data };
    
    // 1. Process date fields
    const dateFields = ['date_of_joining'];
    dateFields.forEach(field => {
        if (cleaned[field] === "" || cleaned[field] === undefined || cleaned[field] === null) {
            cleaned[field] = null;
        }
    });

    // 2. Process numerical fields
    const numFields = ['annual_leave', 'casual_leave'];
    numFields.forEach(field => {
        if (cleaned[field] !== undefined && cleaned[field] !== null) {
            if (cleaned[field] === "") {
                delete cleaned[field]; // Leave unmodified if empty on updates
            } else {
                cleaned[field] = parseInt(cleaned[field], 10) || 0;
            }
        }
    });

    // 3. ✅ STRIP DEPRECATED FIELDS: Hard stop against MySQL "Unknown column" field list exceptions
    delete cleaned.phone_number;
    delete cleaned.gender;
    delete cleaned.dob;
    delete cleaned.address;

    // 4. Strip UI payload operational descriptors
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
        const [rows] = await db.query(
            'SELECT name FROM employees WHERE employee_id = ? LIMIT 1', 
            [empId.trim()]
        );

        if (rows.length === 0) return res.status(404).json({ success: false, message: "ID not found" });

        res.json({ success: true, name: rows[0].name });
    } catch (err) {
        console.error("Public Search Error:", err.message);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

/** --- PROTECTED ROUTES --- **/

/**
 * 2. GET: Fetch All Employees
 */
router.get('/', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TPS']), async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT ${SAFE_FIELDS} FROM employees ORDER BY created_at DESC`
        );
        res.json({ success: true, employees: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 3. POST: Add Employee
 */
router.post('/add', authorize(['Super Admin', 'Admin']), upload.single('profile_image'), async (req, res) => {
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
                // Lock 2FA setups exclusively to root administrators
                delete employeeData.two_factor_secret;
            } else {
                return res.status(403).json({ success: false, message: "Access Denied: Role unauthorized for creation." });
            }
        }

        // If a file was uploaded, assign the path to the profile_image column payload
        if (req.file) {
            employeeData.profile_image = req.file.path.replace(/\\/g, "/"); 
        }

        employeeData.password = password.trim(); 
        employeeData.is_first_login = true; 

        const [insertResult] = await db.query('INSERT INTO employees SET ?', [employeeData]);
        const newInsertedId = insertResult.insertId;

        const [newEmployeeRows] = await db.query(
            `SELECT ${SAFE_FIELDS} FROM employees WHERE id = ?`, 
            [newInsertedId]
        );

        await db.query('INSERT INTO other_logs SET ?', [{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Employee Added",
            timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
            description: `New employee '${employeeData.name}' (${employeeData.role}) added by ${admin_name}.`
        }]);

        res.status(201).json({ success: true, message: "Employee added successfully!", employee: newEmployeeRows[0] });
    } catch (err) {
        console.error("Add Employee Error:", err.message);
        if (err.errno === 1062 || err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: "ID or Email already exists." });
        }
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

        const [users] = await db.query(
            'SELECT id, password FROM employees WHERE employee_id = ? LIMIT 1', 
            [employee_id]
        );

        if (users.length === 0) return res.status(404).json({ success: false, message: "Employee not found." });
        const user = users[0];

        if (user.password !== currentPassword.trim()) {
            return res.status(401).json({ success: false, message: "Current password incorrect." });
        }

        await db.query(
            'UPDATE employees SET password = ?, is_first_login = ? WHERE id = ?',
            [newPassword.trim(), false, user.id]
        );

        res.json({ success: true, message: "Password updated successfully." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 5. PUT: Update Employee Profile
 */
router.put('/:id', authorize(['Super Admin', 'Admin']), upload.single('profile_image'), async (req, res) => {
    try {
        const { id } = req.params;
        const editorRole = req.headers['x-user-role']?.trim().toUpperCase();
        const { admin_id, admin_name, ...rawUpdateData } = req.body;

        const updateData = sanitizeEmployeeData(rawUpdateData);

        const [targets] = await db.query('SELECT role, name FROM employees WHERE id = ? LIMIT 1', [id]);
        if (targets.length === 0) return res.status(404).json({ success: false, message: "Target employee not found." });
        
        const targetUser = targets[0];
        const currentTargetRole = targetUser.role.toUpperCase();

        if (editorRole !== 'SUPER ADMIN') {
            if (editorRole === 'ADMIN') {
                if (currentTargetRole !== 'EMPLOYEES') {
                    return res.status(403).json({ success: false, message: "Access Denied: Admins can only modify 'Employees'." });
                }
                if (updateData.role && updateData.role.toUpperCase() !== 'EMPLOYEES') {
                    return res.status(403).json({ success: false, message: "Access Denied: Admins cannot assign management roles." });
                }
                delete updateData.two_factor_secret;
            } else {
                return res.status(403).json({ success: false, message: "Access Denied: Unauthorized." });
            }
        }

        if (req.file) {
            updateData.profile_image = req.file.path.replace(/\\/g, "/");
        }

        // ✅ FIX: Prevent SQL crash if updateData happens to be completely empty
        if (Object.keys(updateData).length === 0) {
            return res.json({ success: true, message: "No operational changes detected." });
        }

        await db.query('UPDATE employees SET ? WHERE id = ?', [updateData, id]);

        await db.query('INSERT INTO other_logs SET ?', [{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Employee Updated",
            timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
            description: `Profile of '${targetUser.name}' updated by ${admin_name}.`
        }]);

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

        await db.query('DELETE FROM employees WHERE id = ?', [id]);

        await db.query('INSERT INTO other_logs SET ?', [{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Employee Deleted",
            timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
            description: `Employee '${emp_name}' removed by ${admin_name}.`
        }]);

        res.json({ success: true, message: "Employee deleted successfully" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 7. GET: Protected Search
 */
router.get('/search/:empId', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TPS']), async (req, res) => {
    try {
        const { empId } = req.params;
        const [rows] = await db.query(
            'SELECT name FROM employees WHERE employee_id = ? LIMIT 1', 
            [empId.trim()]
        );

        if (rows.length === 0) return res.status(404).json({ success: false, message: "Employee not found." });

        res.json({ success: true, name: rows[0].name });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});



/**
 * 8. GET: Fetch Single Employee Profile Details
 */
router.get('/profile/:id', authorize(['Super Admin', 'Supervisors', 'ER', 'Admin', 'TPS']), async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query(
            `SELECT ${SAFE_FIELDS} FROM employees WHERE id = ? LIMIT 1`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Employee profile not found." });
        }

        res.json({ success: true, employee: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;