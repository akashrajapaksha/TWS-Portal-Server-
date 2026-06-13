const express = require('express');
const router = express.Router();
const db = require('../db'); // ✅ Pointing to your local MySQL Client

/**
 * 🔒 FAIL-SAFE OTPLIB IMPORT
 */
const { authenticator } = require('@otplib/preset-default');

/**
 * @route   POST /api/auth/login
 * @desc    Step 1: Verify password. Bypasses 2FA for Super Admin.
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password required." });
    }

    try {
        // Query the local MySQL portal database
        // ✅ UPDATED: Added profile_image to the SELECT fields
        const queryStr = `
            SELECT id, email, password, role, name, employee_id, is_first_login, two_factor_secret, profile_image 
            FROM employees 
            WHERE LOWER(TRIM(email)) = ? 
            LIMIT 1
        `;
        const [rows] = await db.query(queryStr, [email.toLowerCase().trim()]);
        const user = rows[0];

        if (!user || user.password.trim() !== password.trim()) {
            return res.status(401).json({ success: false, message: "Invalid credentials." });
        }

        const employeeId = user.employee_id || user.id;

        // --- ⭐ SUPER ADMIN BYPASS LOGIC ⭐ ---
        if (user.role === 'Super Admin') {
            const logQuery = `
                INSERT INTO login_logs (employee_id, employee_name, login_time) 
                VALUES (?, ?, NOW())
            `;
            await db.query(logQuery, [employeeId, user.name || user.email]);

            return res.status(200).json({
                success: true,
                require2FA: false, 
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    name: user.name,
                    employee_id: employeeId,
                    is_first_login: user.is_first_login ?? false,
                    profile_image: user.profile_image // ✅ UPDATED: Include in response payload
                }
            });
        }
        // --- END BYPASS ---

        if (!user.two_factor_secret) {
            return res.status(403).json({ 
                success: false, 
                message: "Security Key not configured by Admin. Please contact IT." 
            });
        }

        // Regular employees need 2FA. We pass the image back early 
        // to cache temporarily in state if needed.
        return res.status(200).json({
            success: true,
            require2FA: true,
            user: {
                employee_id: employeeId,
                email: user.email,
                name: user.name,
                profile_image: user.profile_image // ✅ UPDATED: Pass to tempUser object state block
            }
        });

    } catch (err) {
        console.error('Auth Error:', err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

/**
 * @route   POST /api/auth/verify-2fa
 * @desc    Step 2: Verify the 6-digit code for regular employees
 */
router.post('/verify-2fa', async (req, res) => {
    const { employee_id, token } = req.body;

    if (!employee_id || !token) {
        return res.status(400).json({ success: false, message: "Verification details missing." });
    }

    try {
        // ✅ UPDATED: Added profile_image to validation endpoint query pipeline
        const queryStr = `
            SELECT id, email, role, name, employee_id, is_first_login, two_factor_secret, profile_image 
            FROM employees 
            WHERE employee_id = ? 
            LIMIT 1
        `;
        const [rows] = await db.query(queryStr, [employee_id]);
        const user = rows[0];

        if (!user || !user.two_factor_secret) {
            return res.status(404).json({ success: false, message: "User security data not found." });
        }

        const isValid = authenticator.check(
            token.toString().trim(), 
            user.two_factor_secret.toString().trim()
        );

        if (!isValid) {
            return res.status(400).json({ success: false, message: "Invalid or expired code." });
        }

        const logQuery = `
            INSERT INTO login_logs (employee_id, employee_name, login_time) 
            VALUES (?, ?, NOW())
        `;
        await db.query(logQuery, [user.employee_id, user.name || user.email]);

        return res.status(200).json({ 
            success: true, 
            user: {
                id: user.id,
                email: user.email,
                role: user.role || 'Employees',
                name: user.name,
                employee_id: user.employee_id,
                is_first_login: user.is_first_login ?? true,
                profile_image: user.profile_image // ✅ UPDATED: Include in successful 2FA response payload
            }
        });

    } catch (err) {
        console.error('Verification Error:', err);
        return res.status(500).json({ success: false, message: "Verification failed." });
    }
});

/**
 * @route   POST /api/auth/logout
 */
router.post('/logout', async (req, res) => {
    const { employee_id } = req.body;
    try {
        if (employee_id) {
            const logoutQuery = `
                UPDATE employees 
                SET last_logout = NOW() 
                WHERE employee_id = ?
            `;
            await db.query(logoutQuery, [employee_id]);
        }
        return res.status(200).json({ success: true, message: "Logged out successfully" });
    } catch (err) {
        console.error('Logout Error:', err.message);
        return res.status(200).json({ success: true, message: "Logged out (DB update failed)" });
    }
});

/**
 * @route   POST /api/auth/change-password
 */
router.post('/change-password', async (req, res) => {
    const { employee_id, currentPassword, newPassword } = req.body;
    try {
        const checkQuery = `
            SELECT password 
            FROM employees 
            WHERE employee_id = ? 
            LIMIT 1
        `;
        const [rows] = await db.query(checkQuery, [employee_id]);
        const user = rows[0];

        if (!user || user.password.trim() !== currentPassword.trim()) {
            return res.status(401).json({ success: false, message: "Current password incorrect." });
        }

        const updateQuery = `
            UPDATE employees 
            SET password = ?, is_first_login = 0 
            WHERE employee_id = ?
        `;
        await db.query(updateQuery, [newPassword.trim(), employee_id]);

        return res.status(200).json({ success: true, message: "Password updated!" });
    } catch (err) {
        console.error('Change Password Error:', err);
        return res.status(500).json({ success: false, message: "Internal error" });
    }
});

module.exports = router;