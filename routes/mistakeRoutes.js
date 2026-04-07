const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/**
 * LOGIC CONSTANTS
 * ZERO_COUNT_MISTAKES: Administrative or financial logs that should not decrease 
 * performance or count as a "Mistake" in the dashboard total.
 * MONEY_MISTAKES: Types that require an amount to be recorded.
 */
const ZERO_COUNT_MISTAKES = [
    "DOUBLE PAY", 
    "LOCK A BANK", 
    "BREAK", 
    "DOUBLE APPROVE SAME TICKET", 
    "MONEY SHORT"
];

const MONEY_MISTAKES = ["DOUBLE PAY", "MONEY SHORT"];

/**
 * HELPER: processMistakeData
 * Logic: 
 * 1. If type is money-related, record the amount.
 * 2. If type is in ZERO_COUNT_MISTAKES, the 'count' is forced to 0.
 * 3. Standard mistakes (like WRONG KEY) get count: 1 and amount: 0.
 */
const processMistakeData = (body) => {
    const { mistake_type, amount, count } = body;
    let finalAmount = 0;
    let finalCount = 0;

    // Determine Amount
    if (MONEY_MISTAKES.includes(mistake_type)) {
        finalAmount = parseFloat(amount) || 0;
    } else {
        finalAmount = 0;
    }

    // Determine Count
    if (ZERO_COUNT_MISTAKES.includes(mistake_type)) {
        finalCount = 0; 
    } else {
        finalCount = parseInt(count) || 1;
    }

    return { ...body, amount: finalAmount, count: finalCount };
};

/**
 * 0. GET: Auto-fetch Employee Details
 */
router.get('/fetch-by-id/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cleanId = id.trim().toUpperCase();

        const { data, error } = await supabase
            .from('employees')
            .select('name, designation, project')
            .eq('employee_id', cleanId)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        return res.json({
            success: true,
            name: data.name,
            designation: data.designation,
            project: data.project
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

/**
 * 1. POST: Add Mistake
 */
router.post('/add', async (req, res) => {
    try {
        const { admin_id, admin_name, userRole } = req.body;
        
        const allowedRoles = ['Super Admin', 'Supervisors', 'TSP', 'LD'];
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: "Unauthorized to add records." });
        }

        const cleanData = processMistakeData(req.body);
        const { data, error } = await supabase
            .from('mistakes')
            .insert([{ 
                employeeid: cleanData.employeeid.trim().toUpperCase(), 
                employee_name: cleanData.employee_name, 
                project: cleanData.project, 
                employee_position: cleanData.employee_position, 
                date: cleanData.date, 
                shift: cleanData.shift, 
                mistake_type: cleanData.mistake_type, 
                amount: cleanData.amount,
                count: cleanData.count 
            }])
            .select();

        if (error) throw error;

        await supabase.from('other_logs').insert([{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Mistake Added",
            timestamp: new Date().toISOString(),
            description: `Admin ${admin_name} added a '${cleanData.mistake_type}' mistake for ${cleanData.employee_name}.`
        }]);

        res.status(201).json({ success: true, mistake: data[0] });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 2. PUT: Update Mistake
 */
router.put('/:id', async (req, res) => {
    try {
        const { admin_id, admin_name, userRole } = req.body;

        const allowedRoles = ['Super Admin', 'Supervisors', 'TSP', 'LD'];
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: "Unauthorized to update records." });
        }

        const cleanData = processMistakeData(req.body);
        const { data, error } = await supabase
            .from('mistakes')
            .update({
                employeeid: cleanData.employeeid.trim().toUpperCase(),
                employee_name: cleanData.employee_name,
                project: cleanData.project,
                employee_position: cleanData.employee_position,
                date: cleanData.date,
                shift: cleanData.shift,
                mistake_type: cleanData.mistake_type,
                amount: cleanData.amount,
                count: cleanData.count
            })
            .eq('id', req.params.id)
            .select();

        if (error) throw error;

        await supabase.from('other_logs').insert([{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Mistake Updated",
            timestamp: new Date().toISOString(),
            description: `Mistake for ${cleanData.employee_name} updated by ${admin_name}.`
        }]);

        res.json({ success: true, mistake: data[0] });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 3. GET: Fetch All
 */
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('mistakes')
            .select('*')
            .order('date', { ascending: false });

        if (error) throw error;
        res.json({ success: true, mistakes: data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 4. DELETE: Delete Mistake
 */
router.delete('/:id', async (req, res) => {
    try {
        const { admin_id, admin_name, emp_name, mistake_type, userRole } = req.query;

        const allowedRoles = ['Super Admin', 'Supervisors', 'TSP'];
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: "Unauthorized to delete record." });
        }

        const { error } = await supabase
            .from('mistakes')
            .delete()
            .eq('id', req.params.id);
            
        if (error) throw error;

        await supabase.from('other_logs').insert([{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "Mistake Deleted",
            timestamp: new Date().toISOString(),
            description: `The '${mistake_type}' record of ${emp_name} was deleted by ${admin_name}.`
        }]);

        res.json({ success: true, message: "Record deleted" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 5. POST: Promote Mistake to IR
 * NEW LOGIC: Threshold is now 6 mistakes.
 */
router.post('/promote-to-ir', async (req, res) => {
    try {
        const { mistake, admin_id, admin_name, userRole } = req.body;

        const allowedRoles = ['Super Admin', 'Supervisors', 'TSP', 'LD'];
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ success: false, message: "Unauthorized to promote records." });
        }

        // Updated check: Threshold changed from 3 to 6
        const currentCount = parseInt(mistake.count) || 0;
        if (currentCount < 3) {
            return res.status(400).json({ 
                success: false, 
                message: `Mistake count is ${currentCount}. A minimum of 6 mistakes is required to issue an IR.` 
            });
        }

        const { data: irData, error: irError } = await supabase
            .from('incident_reports')
            .insert([{
                full_name: mistake.employee_name,
                emp_no: String(mistake.employeeid).trim().toUpperCase(),
                incident_details: `[PROMOTED FROM MISTAKE]: ${mistake.mistake_type} (Total Cases: ${currentCount})`,
                incident_date: mistake.date,
                amount: parseFloat(mistake.amount || 0),
                status: 'created',
                admin_id: String(admin_id),
                position: mistake.employee_position || 'General Staff',
                description: `Automatically generated IR based on high mistake volume (6+) logged by ${admin_name}.`
            }])
            .select();

        if (irError) throw irError;

        await supabase.from('other_logs').insert([{
            employee_id: admin_id || "System",
            employee_name: admin_name || "Admin",
            action: "MISTAKE_PROMOTED_TO_IR",
            timestamp: new Date().toISOString(),
            description: `Admin ${admin_name} promoted mistake log of ${mistake.employee_name} to an official IR. Final count: ${currentCount}.`
        }]);

        res.status(201).json({ success: true, message: "IR successfully issued (Threshold of 6 reached)", data: irData[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;