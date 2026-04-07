const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

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
        const { data: user, error } = await supabase
            .from('employees')
            // Fetch ONLY what we need for the logic check
            .select('id, email, password, role, name, employee_id, is_first_login, two_factor_secret')
            .eq('email', email.toLowerCase().trim())
            .maybeSingle();

        if (error || !user || user.password.trim() !== password.trim()) {
            return res.status(401).json({ success: false, message: "Invalid credentials." });
        }

        const employeeId = user.employee_id || user.id;

        // --- ⭐ SUPER ADMIN BYPASS LOGIC ⭐ ---
        if (user.role === 'Super Admin') {
            await supabase.from('login_logs').insert([{ 
                employee_id: employeeId, 
                employee_name: user.name || user.email,
                login_time: new Date().toISOString()
            }]);

            return res.status(200).json({
                success: true,
                require2FA: false, 
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    name: user.name,
                    employee_id: employeeId,
                    is_first_login: user.is_first_login ?? false
                }
                // NOTICE: We do NOT return the 'user' object directly. 
                // We construct a new object without the password.
            });
        }
        // --- END BYPASS ---

        if (!user.two_factor_secret) {
            return res.status(403).json({ 
                success: false, 
                message: "Security Key not configured by Admin. Please contact IT." 
            });
        }

        return res.status(200).json({
            success: true,
            require2FA: true,
            user: {
                employee_id: employeeId,
                email: user.email,
                name: user.name
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
        const { data: user, error } = await supabase
            .from('employees')
            // Fetch ONLY what is needed for verification and session
            .select('id, email, role, name, employee_id, is_first_login, two_factor_secret')
            .eq('employee_id', employee_id)
            .single();

        if (error || !user || !user.two_factor_secret) {
            return res.status(404).json({ success: false, message: "User security data not found." });
        }

        const isValid = authenticator.check(
            token.toString().trim(), 
            user.two_factor_secret.toString().trim()
        );

        if (!isValid) {
            return res.status(400).json({ success: false, message: "Invalid or expired code." });
        }

        await supabase.from('login_logs').insert([{ 
            employee_id: user.employee_id, 
            employee_name: user.name || user.email,
            login_time: new Date().toISOString()
        }]);

        return res.status(200).json({ 
            success: true, 
            user: {
                id: user.id,
                email: user.email,
                role: user.role || 'Employees',
                name: user.name,
                employee_id: user.employee_id,
                is_first_login: user.is_first_login ?? true
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
            await supabase
                .from('employees')
                .update({ last_logout: new Date().toISOString() })
                .eq('employee_id', employee_id);
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
        const { data: user } = await supabase
            .from('employees')
            .select('password')
            .eq('employee_id', employee_id)
            .single();

        if (!user || user.password.trim() !== currentPassword.trim()) {
            return res.status(401).json({ success: false, message: "Current password incorrect." });
        }

        await supabase
            .from('employees')
            .update({ password: newPassword.trim(), is_first_login: false })
            .eq('employee_id', employee_id);

        return res.status(200).json({ success: true, message: "Password updated!" });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Internal error" });
    }
});

module.exports = router;