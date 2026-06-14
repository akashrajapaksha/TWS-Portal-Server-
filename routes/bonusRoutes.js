const express = require('express');
const router = express.Router();
const mysqlPool = require('../db'); // Replaced Supabase with local MySQL pool connection hook

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
 * Aggregates database rows into a Shift-Aware O(1) lookup Map
 * Key Pattern format: "YYYY-MM-DD:shiftname"
 */
const aggregateToMap = (data, dateField, shiftField, countField) => {
    const map = new Map();
    data?.forEach(item => {
        const dateKey = normalizeDate(item[dateField]);
        let shiftRaw = String(item[shiftField] || 'morning').toLowerCase().trim();
        let shiftKey = shiftRaw === 'noon' || shiftRaw === 'afternoon' ? 'noon' : (shiftRaw === 'night' ? 'night' : 'morning');
        
        const count = parseInt(item[countField] || 0, 10);
        
        if (dateKey) {
            const compoundKey = `${dateKey}:${shiftKey}`;
            map.set(compoundKey, (map.get(compoundKey) || 0) + count);
        }
    });
    return map;
};

// --- ROUTES ---

/**
 * GET: Identity Status & Project Auto-Fetch
 * URL: /api/bonus/public-search/:id
 */
router.get('/public-search/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false });

    // Security Context Headers
    const requestorId = req.headers['x-employee-id'];
    const requestorRole = req.headers['x-user-role'];

    const cleanId = id.trim().toUpperCase();
    const cleanRequestorId = String(requestorId || '').trim().toUpperCase();
    const cleanRole = String(requestorRole || '').trim().toUpperCase();

    const managementRoles = ['SUPER ADMIN', 'SUPERVISORS', 'ER', 'ADMIN', 'TPS'];
    const selfOnlyRoles = ['LD', 'EMPLOYEES', 'EMPLOYEE'];

    if (selfOnlyRoles.includes(cleanRole) || cleanRole.includes('EMPLOYEE') || cleanRole === 'LD') {
        if (cleanRequestorId !== cleanId) {
            return res.status(403).json({
                success: false,
                message: "Access Denied: You are only authorized to search your own user context."
            });
        }
    } else if (!managementRoles.includes(cleanRole)) {
        if (cleanRequestorId !== cleanId) {
            return res.status(403).json({
                success: false,
                message: "Access Denied: Unauthorized data visibility."
            });
        }
    }

    try {
        const [rows] = await mysqlPool.query(
            'SELECT name, project FROM employees WHERE employee_id = ? LIMIT 1',
            [cleanId]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Employee not found" });
        }

        return res.json({ 
            success: true, 
            name: rows[0].name,
            project: rows[0].project || "Unassigned" 
        });
    } catch (err) {
        console.error("Public Search Error:", err.message);
        return res.status(500).json({ success: false, message: "Internal server error retrieving employee identity profiles." });
    }
});

/**
 * POST: Multi-Project Performance & Dynamic Bonus Calculation Engine
 * URL: /api/bonus/analyze
 */
router.post('/analyze', async (req, res) => {
    const { employeeId, employeeName, project, startDate, endDate } = req.body;
    
    // Security Header Context
    const requestorId = req.headers['x-employee-id'];
    const requestorRole = req.headers['x-user-role'];

    const cleanRole = String(requestorRole || '').trim().toUpperCase();
    const cleanId = String(employeeId || '').trim().toUpperCase();
    const cleanRequestorId = String(requestorId || '').trim().toUpperCase();

    const managementRoles = ['SUPER ADMIN', 'SUPERVISORS', 'ER', 'ADMIN', 'TPS'];
    const selfOnlyRoles = ['LD', 'EMPLOYEES', 'EMPLOYEE'];

    if (selfOnlyRoles.includes(cleanRole) || cleanRole.includes('EMPLOYEE') || cleanRole === 'LD') {
        if (cleanRequestorId !== cleanId) {
            return res.status(403).json({ 
                success: false, 
                error: "Access Denied: You are restricted to your own performance data." 
            });
        }
    } else if (!managementRoles.includes(cleanRole)) {
        if (cleanRequestorId !== cleanId) {
            return res.status(403).json({
                success: false,
                error: "Access Denied: Insufficient authorization permissions."
            });
        }
    }

    if (!employeeId || !startDate || !endDate || !project) {
        return res.status(400).json({ success: false, error: "Missing required tracking parameters." });
    }

    try {
        // 1. Fetch Project Configuration Rules Matrix
        const [projRows] = await mysqlPool.query(
            'SELECT bonus_tiers FROM projects WHERE name = ? LIMIT 1',
            [project]
        );

        if (!projRows || projRows.length === 0) {
            return res.status(404).json({ success: false, error: `Configuration rules for project '${project}' not found.` });
        }

        let targetProjectShiftRules = { morning: [], noon: [], night: [] };
        let bonusTiersRaw = projRows[0].bonus_tiers;
        if (typeof bonusTiersRaw === 'string') {
            try { 
                const parsedTiers = JSON.parse(bonusTiersRaw); 
                if (parsedTiers && (parsedTiers.morning || parsedTiers.noon || parsedTiers.night)) {
                    targetProjectShiftRules = parsedTiers;
                }
            } catch(e) { 
                console.warn("Parsing bonus_tiers layout failed.");
            }
        } else if (bonusTiersRaw && typeof bonusTiersRaw === 'object') {
            targetProjectShiftRules = bonusTiersRaw;
        }

        // 2. Fetch Performance Metrics Concurrently
        const [exclusionsRes, ordersRes, mistakesRes] = await Promise.all([
            mysqlPool.query('SELECT excluded_date FROM employee_exclusions WHERE employee_id = ? AND excluded_date BETWEEN ? AND ?', [cleanId, startDate, endDate]),
            mysqlPool.query('SELECT order_count, date, shift FROM orders WHERE employee_id = ? AND date BETWEEN ? AND ?', [cleanId, startDate, endDate]),
            mysqlPool.query('SELECT count, date, shift FROM mistakes WHERE employeeid = ? AND date BETWEEN ? AND ?', [cleanId, startDate, endDate])
        ]);

        const excludedSet = new Set(exclusionsRes[0]?.map(e => normalizeDate(e.excluded_date)) || []);
        const ordersMap = aggregateToMap(ordersRes[0], 'date', 'shift', 'order_count');
        const mistakesMap = aggregateToMap(mistakesRes[0], 'date', 'shift', 'count');

        // Master variables to sum up EVERYTHING across the period
        let totalOrdersGlobal = 0;
        let totalMistakesGlobal = 0;
        let activeDaysCount = 0;

        // Shift isolated calculations trackers used purely for checking bonus scales
        const shiftTotals = {
            morning: { orders: 0, mistakes: 0, net: 0 },
            noon:    { orders: 0, mistakes: 0, net: 0 },
            night:   { orders: 0, mistakes: 0, net: 0 }
        };

        const dailyBreakdown = [];
        const shiftKeys = ['morning', 'noon', 'night'];
        
        let curr = new Date(startDate);
        const last = new Date(endDate);

        // Period Date Range Loop
        while (curr <= last) {
            const dateStr = normalizeDate(curr);
            const isExcluded = excludedSet.has(dateStr);

            let dayOrdersSum = 0;
            let dayMistakesSum = 0;

            // Gather metrics across shifts for this specific day
            shiftKeys.forEach(shiftKey => {
                const compoundKey = `${dateStr}:${shiftKey}`;
                const orders = ordersMap.get(compoundKey) || 0;
                const mistakes = mistakesMap.get(compoundKey) || 0;

                dayOrdersSum += orders;
                dayMistakesSum += mistakes;

                if (!isExcluded) {
                    shiftTotals[shiftKey].orders += orders;
                    shiftTotals[shiftKey].mistakes += mistakes;
                }
            });

            const dayNetScore = isExcluded ? 0 : (dayOrdersSum - (dayMistakesSum * 5));

            if (!isExcluded) {
                totalOrdersGlobal += dayOrdersSum;
                totalMistakesGlobal += dayMistakesSum;
                activeDaysCount++;
            }

            dailyBreakdown.push({
                date: dateStr,
                orders: dayOrdersSum,
                mistakes: dayMistakesSum,
                net: dayNetScore,
                status: isExcluded ? 'Excluded' : 'Active'
            });

            curr.setUTCDate(curr.getUTCDate() + 1);
        }

        // Calculate global net performance score across all worked shifts
        const totalNetGlobal = totalOrdersGlobal - (totalMistakesGlobal * 5);

        // 3. Process Shift Payout Bonuses & Threshold Lookups Independently
        let combinedBonusPayout = 0;
        const shiftViewDetails = {};

        shiftKeys.forEach(shiftKey => {
            // Compute true shift-isolated performance metrics score for debugging/logs if needed
            const shiftNetScore = shiftTotals[shiftKey].orders - (shiftTotals[shiftKey].mistakes * 5);
            shiftTotals[shiftKey].net = shiftNetScore;

            const rules = Array.isArray(targetProjectShiftRules[shiftKey]) ? targetProjectShiftRules[shiftKey] : [];
            
            // CRITICAL FIX: Evaluate the achieved milestone tier rule based on the GLOBAL net score
            const achievedTier = [...rules]
                .sort((a, b) => b.threshold - a.threshold)
                .find(r => totalNetGlobal >= r.threshold);

            const shiftBonus = achievedTier ? achievedTier.bonus : 0;
            combinedBonusPayout += shiftBonus; // Accumulate shift payouts into the combined master bonus

            // CRITICAL FIX: Find the next milestone threshold using the GLOBAL net score
            const nextTier = [...rules]
                .sort((a, b) => a.threshold - b.threshold)
                .find(r => r.threshold > totalNetGlobal);

            // Populate localized metrics data structures required by Frontend tabs
            shiftViewDetails[shiftKey] = {
                activeDays: activeDaysCount,
                calculatedBonus: shiftBonus,
                metrics: {
                    totalOrders: totalOrdersGlobal,     // Forces matching across all shifts
                    totalMistakes: totalMistakesGlobal, // Forces matching across all shifts
                    totalNet: totalNetGlobal,           // Forces matching across all shifts
                    nextTierInfo: nextTier ? {
                        nextThreshold: nextTier.threshold,
                        // FIX: Calculate the true remaining gap against the overall accumulated performance global net score
                        gapToNext: nextTier.threshold - totalNetGlobal, 
                        potentialBonus: nextTier.bonus
                    } : null
                }
            };
        });

        // 4. Return summary payload structure matching layout expectations
        return res.status(200).json({
            success: true,
            summary: {
                employeeId: cleanId,
                employeeName,
                project,
                durationDays: activeDaysCount,
                calculatedBonus: combinedBonusPayout, // Combined total sum of all shifts
                shifts: shiftViewDetails,
                dailyBreakdown
            }
        });

    } catch (error) {
        console.error("Calculation Engine Processing Fault:", error);
        return res.status(500).json({ success: false, error: "Internal server error running multi-project calculation engine." });
    }
});

module.exports = router;