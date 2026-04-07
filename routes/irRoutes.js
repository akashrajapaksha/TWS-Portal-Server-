const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

// List of high-severity mistakes that trigger an IR regardless of count
const HIGH_SEVERITY_MISTAKES = [
    "DOUBLE PAY", 
    "LOCK A BANK", 
    "BREAK", 
    "DOUBLE APPROVE SAME TICKET", 
    "MONEY SHORT"
];

/**
 * 1. Auto-fetch Employee Details by ID
 */
router.get('/fetch-by-id/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('employees')
            .select('name, initials, designation') 
            .eq('employee_id', id.trim().toUpperCase()) 
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        return res.json({
            success: true,
            name: data.name,
            initials: data.initials || '',
            position: data.designation || 'Staff' 
        });
    } catch (err) {
        console.error("Fetch Error:", err.message);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

/**
 * 2. GET: Fetch Incident Reports (IR)
 * Logic: Triggers if (Daily Mistakes >= 3) OR (Contains High Severity Mistake)
 */
router.get('/', async (req, res) => {
    try {
        const { userRole, loggedInEmployeeId, searchId } = req.query;

        let irQuery = supabase.from('incident_reports').select('*');

        if (userRole === 'Employees') {
            irQuery = irQuery.eq('emp_no', String(loggedInEmployeeId).trim());
        } else if (searchId) {
            irQuery = irQuery.eq('emp_no', String(searchId).trim().toUpperCase());
        }

        const { data: existingIR, error: irError } = await irQuery.order('incident_date', { ascending: false });
        if (irError) throw irError;

        let formattedPending = [];
        const privilegedRoles = ['Super Admin', 'Supervisors', 'ER', 'TSP', 'LD', 'Admin'];
        
        if (privilegedRoles.includes(userRole)) {
            const { data: pendingCandidates, error: mistakeError } = await supabase
                .rpc('get_pending_ir_candidates'); 

            if (!mistakeError && pendingCandidates) {
                const existingKeys = new Set(
                    (existingIR || []).map(ir => `${String(ir.emp_no).trim()}-${ir.incident_date}`)
                );

                formattedPending = pendingCandidates
                    .filter(p => {
                        const pendingKey = `${String(p.official_emp_no).trim()}-${p.mistake_date}`;
                        const details = (p.combined_mistakes || "").toUpperCase();
                        
                        // NEW LOGIC: Check if details contain any High Severity keywords
                        const hasHighSeverity = HIGH_SEVERITY_MISTAKES.some(m => details.includes(m));
                        const hasHighFrequency = parseInt(p.total_mistake_count) >= 3;

                        // Only show if not already an official IR AND (Frequency >= 3 OR Severity is high)
                        return !existingKeys.has(pendingKey) && (hasHighFrequency || hasHighSeverity);
                    })
                    .map(p => {
                        const details = (p.combined_mistakes || "").toUpperCase();
                        const isHighSeverity = HIGH_SEVERITY_MISTAKES.some(m => details.includes(m));
                        const isMonetary = details.includes("MONEY SHORT") || details.includes("DOUBLE PAY");

                        return {
                            id: `pending-${p.official_emp_no}-${p.mistake_date}`,
                            emp_no: String(p.official_emp_no),
                            full_name: p.name,
                            incident_date: p.mistake_date,
                            incident_details: isHighSeverity 
                                ? `[CRITICAL MISTAKE]: ${p.combined_mistakes}`
                                : `[DAILY THRESHOLD]: ${p.total_mistake_count} mistakes on ${p.mistake_date}`,
                            mistake_count: parseInt(p.total_mistake_count) || 0,
                            amount: isMonetary ? parseFloat(p.total_amount || 0) : 0,
                            status: 'pending',
                            position: p.position || 'General Staff'
                        };
                    });
            }
        }

        return res.status(200).json({ 
            success: true, 
            data: [...formattedPending, ...(existingIR || [])] 
        });

    } catch (err) {
        console.error("Server Error (GET IR):", err.message);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

/**
 * 3. POST: Create New IR (Manual)
 */
router.post('/add', async (req, res) => {
    try {
        const { 
            fullName, nickName, initials, empNo, position, 
            details, dateIncident, description, prevention, 
            adminId, adminName, amount, userRole 
        } = req.body;

        if (userRole === 'Employees') return res.status(403).json({ success: false, error: "Access Denied." });

        const insertData = {
            full_name: fullName,
            nick_name: nickName || '',
            initials: initials || '',
            emp_no: String(empNo).trim().toUpperCase(),
            incident_details: details,
            incident_date: dateIncident,
            description: description || '',
            prevention: prevention || '',
            admin_id: String(adminId),
            position: position || 'General Staff',
            status: 'created',
            amount: parseFloat(amount || 0)
        };

        const { data: irData, error: irError } = await supabase.from('incident_reports').insert([insertData]).select().single();
        if (irError) throw irError;

        await supabase.from('other_logs').insert([{
            employee_id: String(adminId),
            employee_name: adminName || "System",
            action: "IR_ISSUED",
            timestamp: new Date().toISOString(),
            description: `Official IR issued to ${fullName} (${empNo}).`
        }]);

        return res.status(201).json({ success: true, data: irData });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * 4. DELETE: Remove IR
 */
router.delete('/:id', async (req, res) => {
    try {
        const { userRole } = req.query;
        const allowedToDelete = ['Super Admin', 'Supervisors', 'ER', 'TSP', 'LD'];
        if (!allowedToDelete.includes(userRole)) return res.status(403).json({ success: false, error: "Unauthorized." });

        const { error } = await supabase.from('incident_reports').delete().eq('id', req.params.id);
        if (error) throw error;
        return res.json({ success: true, message: "Deleted successfully" });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 5. POST: Promote Mistake to IR
 */
router.post('/promote-from-mistake', async (req, res) => {
    try {
        const { mistake, adminId, adminName, userRole } = req.body;
        const allowedRoles = ['Super Admin', 'Supervisors', 'TSP', 'LD', 'Admin'];
        
        if (!allowedRoles.includes(userRole)) return res.status(403).json({ success: false, error: "Unauthorized." });

        const details = (mistake.incident_details || "").toUpperCase();
        const isHighSeverity = HIGH_SEVERITY_MISTAKES.some(m => details.includes(m));
        const count = parseInt(mistake.mistake_count);

        // Validation: Must be either 3+ mistakes OR a high severity mistake
        if (count < 3 && !isHighSeverity) {
            return res.status(400).json({ success: false, error: "Threshold not met for IR issuance." });
        }

        const insertData = {
            full_name: mistake.full_name,
            emp_no: String(mistake.emp_no).trim().toUpperCase(),
            incident_details: mistake.incident_details,
            incident_date: mistake.incident_date,
            description: isHighSeverity 
                ? `Critical severity mistake (${details}) promoted to IR.` 
                : `Daily limit exceeded (${count} mistakes) promoted to IR.`,
            admin_id: String(adminId),
            position: mistake.position || 'General Staff',
            status: 'created',
            amount: parseFloat(mistake.amount || 0)
        };

        const { data, error } = await supabase.from('incident_reports').insert([insertData]).select().single();
        if (error) throw error;

        await supabase.from('other_logs').insert([{
            employee_id: String(adminId),
            employee_name: adminName || "System",
            action: "IR Issued for Mistakes",
            timestamp: new Date().toISOString(),
            description: `Promoted mistake for ${mistake.full_name} (${mistake.emp_no}) to IR.`
        }]);

        return res.status(201).json({ success: true, data });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;