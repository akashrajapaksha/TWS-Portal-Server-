const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../db'); // Your working MySQL Client Pool configuration

// --- 📦 MULTER FILE STORAGE CONFIGURATION ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/medical_docs/'); 
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
        return cb(null, true);
    } else {
        cb(new Error('Format rejected. Only PDF, JPG, JPEG, or PNG system files are permitted.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } 
});


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
 * 🧮 HELPER: Calculate Annual and Casual Balances
 */
const calculateRemainingBalance = async (employee_id) => {
    const [empRows] = await db.execute(
        "SELECT annual_leave, casual_leave FROM employees WHERE employee_id = ? LIMIT 1",
        [employee_id]
    );
    
    if (!empRows || empRows.length === 0) {
        return { annual_balance: 0, casual_balance: 0, annual_total: 0, casual_total: 0 };
    }
    const emp = empRows[0];

    const [res1, res2] = await Promise.all([
        db.execute(
            `SELECT leave_type, NULL as deduct_from, SUM(number_of_days) as total_days 
             FROM leave_applications 
             WHERE employee_id = ? AND status = 'Approved' 
             GROUP BY leave_type`,
            [employee_id]
        ),
        // 🔥 FIXED: Standardized case-insensitivity processing directly in SQL to prevent dropouts
        db.execute(
            `SELECT leave_type, UPPER(TRIM(deduct_from)) as deduct_from, SUM(number_of_days) as total_days 
             FROM leave_applications_two 
             WHERE employee_id = ? 
               AND status IN ('Approved', 'Pending_ER_Supervisor') 
               AND UPPER(TRIM(deduct_from)) IN ('CASUAL', 'ANNUAL')
             GROUP BY leave_type, UPPER(TRIM(deduct_from))`,
            [employee_id]
        )
    ]);

    const allLeaveRows = [...(res1[0] || []), ...(res2[0] || [])];
    let takenAnnual = 0;
    let takenCasual = 0;

    allLeaveRows.forEach(row => {
        const type = row.leave_type ? row.leave_type.toLowerCase().trim() : '';
        const deduct = row.deduct_from ? row.deduct_from.toLowerCase().trim() : 'none';

        if (type === 'annual' || deduct === 'annual') {
            takenAnnual += parseFloat(row.total_days) || 0;
        }
        if (type === 'casual' || deduct === 'casual') {
            takenCasual += parseFloat(row.total_days) || 0;
        }
    });

    return {
        annual_total: emp.annual_leave || 0,
        casual_total: emp.casual_leave || 0,
        taken_annual: takenAnnual,
        taken_casual: takenCasual,
        annual_balance: Math.max(0, (emp.annual_leave || 0) - takenAnnual),
        casual_balance: Math.max(0, (emp.casual_leave || 0) - takenCasual)
    };
};

/**
 * 🚀 1. POST: Apply for Leave
 */
router.post('/apply', upload.single('document'), async (req, res) => {
    try {
        const { 
            employee_id, 
            employee_name, 
            leave_type, 
            start_date, 
            end_date, 
            number_of_days, 
            reason, 
            user_id,
            project_name 
        } = req.body;

        if (!leave_type || !employee_id) {
            return res.status(400).json({ success: false, message: "Employee ID and Leave type are required." });
        }

        const normalizedType = leave_type.toLowerCase().trim();

        if (normalizedType === 'medical' && !req.file) {
            return res.status(400).json({ 
                success: false, 
                message: "Validation Error: Medical leaves require a supporting documentation attachment file upload." 
            });
        }

        const [userRows] = await db.execute("SELECT role FROM employees WHERE employee_id = ? LIMIT 1", [employee_id]);
        if (!userRows || userRows.length === 0) {
            return res.status(404).json({ success: false, message: "Applying employee context not found." });
        }
        const applicantRole = userRows[0].role.trim().toUpperCase();
        
        let initialStatus = 'Pending_Admin'; 
        if (applicantRole === 'ADMIN') {
            initialStatus = 'Pending_ER_Supervisor'; 
        } else if (applicantRole === 'ER') {
            initialStatus = 'Pending_Supervisor'; 
        }
        
        let targetTable = (normalizedType === 'annual' || normalizedType === 'casual') 
                        ? 'leave_applications' 
                        : 'leave_applications_two';

        const finalProjectName = project_name && project_name.trim() ? project_name.trim() : 'GENERAL';
        const attachmentUrl = req.file ? `/uploads/medical_docs/${req.file.filename}` : null;

        let mysqlQuery = '';
        let queryParams = [];

        if (targetTable === 'leave_applications_two') {
            mysqlQuery = `
                INSERT INTO leave_applications_two 
                (employee_id, employee_name, leave_type, deduct_from, start_date, end_date, number_of_days, reason, user_id, project_name, attachment_url, status, apply_date) 
                VALUES (?, ?, ?, 'NONE', ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `;
            queryParams = [employee_id, employee_name || null, leave_type, start_date || null, end_date || null, number_of_days || 0, reason || null, user_id || null, finalProjectName, attachmentUrl, initialStatus];
        } else {
            mysqlQuery = `
                INSERT INTO leave_applications 
                (employee_id, employee_name, leave_type, start_date, end_date, number_of_days, reason, user_id, project_name, status, apply_date) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `;
            queryParams = [employee_id, employee_name || null, leave_type, start_date || null, end_date || null, number_of_days || 0, reason || null, user_id || null, finalProjectName, initialStatus];
        }
        
        const [result] = await db.execute(mysqlQuery, queryParams);

        if (req.io) {
            if (initialStatus === 'Pending_Admin') {
                req.io.to('ADMIN').emit('new_leave_notification', {
                    message: `New leave request submitted by ${employee_name} (${finalProjectName}).`,
                    applicant_id: employee_id
                });
            } else if (initialStatus === 'Pending_ER_Supervisor') {
                req.io.to('ER').to('SUPERVISORS').emit('new_leave_notification', {
                    message: `Admin ${employee_name} has submitted a leave request. Awaiting second-level approval.`,
                    applicant_id: employee_id
                });
            } else if (initialStatus === 'Pending_Supervisor') {
                req.io.to('SUPERVISORS').emit('new_leave_notification', {
                    message: `ER Specialist ${employee_name} has submitted a leave request. Awaiting Supervisor approval.`,
                    applicant_id: employee_id
                });
            }
        }

        res.status(201).json({ 
            success: true, 
            message: `Application submitted successfully. Routed status: ${initialStatus}`, 
            applicationId: result.insertId 
        });
    } catch (err) {
        console.error("Application Post Routing Error:", err);
        res.status(500).json({ success: false, message: "Database Error: " + err.message });
    }
});

/**
 * ✅ 2. PATCH: Unified Workflow Evaluation Action
 */
router.patch('/process-action/:id', authorize(['Admin', 'ER', 'Supervisors', 'Super Admin']), async (req, res) => {
    try {
        const { id } = req.params; 
        const { action_type, approver_id, approver_name, leave_type, comment, deduct_from } = req.body; 
        
        if (!leave_type) return res.status(400).json({ success: false, message: "Leave type is required." });
        if (!approver_id) return res.status(400).json({ success: false, message: "Approver identification context is required." });

        const rawApproverRole = req.headers['x-user-role'];
        const approverRole = rawApproverRole ? rawApproverRole.trim().toUpperCase() : '';

        const normType = leave_type.toLowerCase().trim();
        const targetTable = (normType === 'medical' || normType === 'no pay') ? 'leave_applications_two' : 'leave_applications';

        const [appRows] = await db.execute(`SELECT status, employee_id, employee_name FROM ${targetTable} WHERE id = ? LIMIT 1`, [id]);
        if (!appRows || appRows.length === 0) return res.status(404).json({ success: false, message: "Application record missing." });
        
        const currentStatus = appRows[0].status;
        const applicantId = appRows[0].employee_id;
        const applicantName = appRows[0].employee_name;

        let nextStatus = currentStatus;
        let auditAction = '';

        if (action_type === 'REJECT') {
            nextStatus = 'Rejected';
            auditAction = 'Leave Rejected';
            if (!comment || !comment.trim()) {
                return res.status(400).json({ success: false, message: "A comment or reason is mandatory when rejecting requests." });
            }
        } else if (action_type === 'PASS_TO_ER') {
            if (approverRole !== 'ADMIN') {
                return res.status(403).json({ success: false, message: "Only Admin roles can pass operations onwards to ER processing rows." });
            }
            nextStatus = 'Pending_ER_Supervisor';
            auditAction = 'Passed to ER Tier';
        } else if (action_type === 'APPROVE') {
            if (['ER', 'SUPERVISORS', 'SUPER ADMIN', 'ADMIN'].includes(approverRole)) {
                nextStatus = 'Approved';
                auditAction = 'Leave Approved';
            } else {
                return res.status(403).json({ success: false, message: "Admin accounts can only reject or pass requests to ER branches." });
            }
        }

        // Commit dynamic data changes to database layers
        if (targetTable === 'leave_applications_two') {
            // 🔥 FIXED: Strict checks to prevent empty string payloads ("") from wiping the previous choice.
            if (deduct_from && deduct_from.trim() !== "" && deduct_from.trim().toUpperCase() !== "NONE") {
                const chosenDeduction = deduct_from.trim().toUpperCase();
                await db.execute(
                    `UPDATE leave_applications_two SET status = ?, reject_reason = ?, deduct_from = ? WHERE id = ?`, 
                    [nextStatus, comment || null, chosenDeduction, id]
                );
            } else {
                // If the incoming payload has an empty, null, or missing deduct_from, DO NOT update that column.
                await db.execute(
                    `UPDATE leave_applications_two SET status = ?, reject_reason = ? WHERE id = ?`, 
                    [nextStatus, comment || null, id]
                );
            }
        } else {
            await db.execute(
                `UPDATE leave_applications SET status = ?, reject_reason = ? WHERE id = ?`, 
                [nextStatus, comment || null, id]
            );
        }

        const deductionNote = deduct_from ? ` (Deducted from: ${deduct_from})` : '';
        await db.execute(
            "INSERT INTO other_logs (employee_id, employee_name, action, description) VALUES (?, ?, ?, ?)",
            [
                approver_id,
                approver_name || null,
                auditAction,
                `Application ID ${id} set to ${nextStatus} by ${approver_name} (${approverRole}).${deductionNote} Comment: ${comment || 'None'}`
            ]
        );

        if (req.io) {
            if (action_type === 'REJECT') {
                if (approverRole === 'ADMIN') {
                    req.io.to(`user_${applicantId}`).emit('leave_status_changed', {
                        message: `Your leave request has been rejected by Admin. Reason: ${comment}`
                    });
                } else {
                    req.io.to(`user_${applicantId}`).to('ADMIN').emit('leave_status_changed', {
                        message: `Leave request for ${applicantName} was rejected by ${approverRole}. Reason: ${comment}`
                    });
                }
            } else if (action_type === 'PASS_TO_ER') {
                req.io.to('ER').to('SUPERVISORS').emit('new_leave_notification', {
                    message: `Admin passed leave request for ${applicantName} to ER processing rows.`
                });
            } else if (action_type === 'APPROVE') {
                req.io.to(`user_${applicantId}`).to('ADMIN').emit('leave_status_changed', {
                    message: `Leave request for ${applicantName} has been fully APPROVED by ${approverRole}.`
                });
            }
        }

        res.json({ success: true, message: `Application processed successfully. Next status state: ${nextStatus}` });
    } catch (err) {
        console.error("Workflow Update Error:", err);
        res.status(500).json({ success: false, message: "Sync Error: " + err.message });
    }
});

/**
 * 👑 3. GET: Dashboard View
 */
router.get('/dashboard-list', authorize(['Admin', 'ER', 'Supervisors', 'Super Admin']), async (req, res) => {
    try {
        const rawApproverRole = req.headers['x-user-role'];
        const approverRole = rawApproverRole ? rawApproverRole.trim().toUpperCase() : '';

        const [res1, res2] = await Promise.all([
            db.execute("SELECT *, NULL as attachment_url, NULL as deduct_from FROM leave_applications WHERE status NOT IN ('Approved', 'Rejected')"),
            db.execute("SELECT * FROM leave_applications_two WHERE status NOT IN ('Approved', 'Rejected')")
        ]);

        let combined = [...(res1[0] || []), ...(res2[0] || [])];

        if (approverRole === 'ADMIN') {
            combined = combined.filter(app => app.status === 'Pending_Admin');
        } else if (approverRole === 'ER') {
            combined = combined.filter(app => app.status === 'Pending_ER_Supervisor');
        } else if (['SUPERVISORS', 'SUPER ADMIN'].includes(approverRole)) {
            combined = combined.filter(app => ['Pending_ER_Supervisor', 'Pending_Supervisor'].includes(app.status));
        }

        res.json({ success: true, leaves: combined });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 📊 4. GET: Analytics Context Matrix Checker
 */
router.get('/metrics-lookup', authorize(['Admin', 'ER', 'Supervisors', 'Super Admin']), async (req, res) => {
    try {
        const { target_employee_id, search_date } = req.query;
        if (!target_employee_id || !search_date) {
            return res.status(400).json({ success: false, message: "Missing target_employee_id or search_date query parameters." });
        }

        const balanceMetrics = await calculateRemainingBalance(target_employee_id);

        const countQuery1 = `SELECT COUNT(*) as activeCount FROM leave_applications WHERE ? BETWEEN start_date AND end_date AND status = 'Approved' AND employee_id != ?`;
        const countQuery2 = `SELECT COUNT(*) as activeCount FROM leave_applications_two WHERE ? BETWEEN start_date AND end_date AND status = 'Approved' AND employee_id != ?`;

        const [countRes1, countRes2] = await Promise.all([
            db.execute(countQuery1, [search_date, target_employee_id]),
            db.execute(countQuery2, [search_date, target_employee_id]),
        ]);

        const totalOtherStaffOut = (countRes1[0][0].activeCount || 0) + (countRes2[0][0].activeCount || 0);

        res.json({
            success: true,
            employeeBalances: {
                annual_allocated: balanceMetrics.annual_total,
                casual_allocated: balanceMetrics.casual_total,
                annual_remaining: balanceMetrics.annual_balance,
                casual_remaining: balanceMetrics.casual_balance,
                total_approved_historical: balanceMetrics.taken_annual + balanceMetrics.taken_casual
            },
            dateAnalytics: {
                target_date: search_date,
                other_employees_approved_count: totalOtherStaffOut
            }
        });
    } catch (err) {
        console.error("Metrics Lookup Error:", err);
        res.status(500).json({ success: false, message: "Lookup processing error: " + err.message });
    }
});

/**
 * 📄 5. GET: All leaves for a specific employee
 */
router.get('/my-leaves/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const [res1, res2] = await Promise.all([
            db.execute("SELECT *, NULL as attachment_url, NULL as deduct_from FROM leave_applications WHERE employee_id = ? ORDER BY id DESC", [empId]),
            db.execute("SELECT * FROM leave_applications_two WHERE employee_id = ? ORDER BY id DESC", [empId])
        ]);

        const combined = [...(res1[0] || []), ...(res2[0] || [])].sort((a, b) => {
            return new Date(b.apply_date || b.created_at) - new Date(a.apply_date || a.created_at);
        });

        res.json({ success: true, leaves: combined });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 💰 6. GET: Clean Balance Calculations
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