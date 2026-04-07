const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/**
 * Robust Date Formatter
 * Ensures dates are treated as YYYY-MM-DD without timezone shifts
 */
const normalizeDate = (dateInput) => {
    if (!dateInput) return null;
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
};

/**
 * Aggregates data into a Map
 */
const aggregateToMap = (data, dateField, countField) => {
    const map = new Map();
    data?.forEach(item => {
        const dateKey = normalizeDate(item[dateField]);
        const count = parseInt(item[countField] || 0, 10);
        if (dateKey) {
            map.set(dateKey, (map.get(dateKey) || 0) + count);
        }
    });
    return map;
};

// --- ROUTES ---

/**
 * GET: Identity Status auto-fetch
 */
router.get('/public-search/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false });

    try {
        const cleanId = id.trim().toUpperCase();
        const { data, error } = await supabase
            .from('employees')
            .select('name')
            .eq('employee_id', cleanId)
            .maybeSingle();

        if (error || !data) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        return res.json({ success: true, name: data.name });
    } catch (err) {
        console.error("Public Search Error:", err.message);
        return res.status(500).json({ success: false });
    }
});

/**
 * GET: Main Performance Calculation
 * Dynamic Logic: Net = Orders - (Mistakes * 5)
 * Tiers are fetched dynamically based on the employee's assigned project.
 */
router.get('/calculate/:employeeId', async (req, res) => {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;

    const requestorId = req.headers['x-employee-id'];
    const requestorRole = req.headers['x-user-role'];

    // Security Enforcement
    if (requestorRole === 'Employees' && String(requestorId) !== String(employeeId)) {
        return res.status(403).json({ 
            success: false, 
            message: "Access Denied: You are restricted to your own performance data." 
        });
    }

    if (!startDate || !endDate) {
        return res.status(400).json({ success: false, message: "Date range required." });
    }

    try {
        const cleanId = employeeId.trim().toUpperCase();

        // 1. Fetch Employee and their linked Project Name
        const { data: empData, error: empErr } = await supabase
            .from('employees')
            .select('name, project')
            .eq('employee_id', cleanId)
            .maybeSingle();

        if (empErr || !empData) {
            return res.status(404).json({ success: false, message: "Employee not found in database." });
        }

        // 2. Fetch Project-Specific Bonus Tiers from the projects table
        const { data: projData, error: projErr } = await supabase
            .from('projects')
            .select('bonus_tiers')
            .eq('name', empData.project)
            .maybeSingle();

        // 3. Parallel Fetch Performance Data
        const [exclusionsRes, ordersRes, mistakesRes] = await Promise.all([
            supabase.from('employee_exclusions').select('excluded_date').eq('employee_id', cleanId).gte('excluded_date', startDate).lte('excluded_date', endDate),
            supabase.from('orders').select('order_count, date').eq('employee_id', cleanId).gte('date', startDate).lte('date', endDate),
            supabase.from('mistakes').select('count, date').eq('employeeid', cleanId).gte('date', startDate).lte('date', endDate)
        ]);

        // 4. Data Processing
        const excludedSet = new Set(exclusionsRes.data?.map(e => normalizeDate(e.excluded_date)) || []);
        const ordersMap = aggregateToMap(ordersRes.data, 'date', 'order_count');
        const mistakesMap = aggregateToMap(mistakesRes.data, 'date', 'count');

        // 5. Breakdown Generation
        const dailyBreakdown = [];
        let totalNet = 0;
        
        let curr = new Date(startDate);
        const last = new Date(endDate);

        while (curr <= last) {
            const dateStr = normalizeDate(curr);
            const isExcluded = excludedSet.has(dateStr);
            const orders = ordersMap.get(dateStr) || 0;
            const mistakes = mistakesMap.get(dateStr) || 0;
            
            // Formula: Net = Orders - (Mistakes * 5)
            const net = isExcluded ? 0 : (orders - (mistakes * 5));
            
            if (!isExcluded) {
                totalNet += net;
            }

            dailyBreakdown.push({
                date: dateStr,
                orders,
                mistakes,
                net,
                status: isExcluded ? 'Excluded' : 'Active'
            });

            curr.setUTCDate(curr.getUTCDate() + 1);
        }

        // 6. Dynamic Bonus Tier Calculation
        // Use projData.bonus_tiers if available, otherwise default to empty array
        const tiers = projData?.bonus_tiers || [];

        // Find the highest tier where totalNet >= threshold
        const currentTier = [...tiers]
            .sort((a, b) => b.threshold - a.threshold) // Sort descending to find the top tier met
            .find(t => totalNet >= t.threshold);

        // Find the next available tier for progression logic
        const nextTier = [...tiers]
            .sort((a, b) => a.threshold - b.threshold) // Sort ascending to find the next target
            .find(t => t.threshold > totalNet);

        return res.json({
            success: true,
            employeeName: empData.name,
            projectName: empData.project || "Unassigned",
            totalNet,
            bonusUSD: currentTier ? currentTier.bonus : 0,
            dailyBreakdown,
            nextTier: nextTier ? {
                nextThreshold: nextTier.threshold,
                gapToNext: nextTier.threshold - totalNet,
                potentialBonus: nextTier.bonus
            } : null
        });

    } catch (error) {
        console.error("Calculation Engine Error:", error);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
});

module.exports = router;