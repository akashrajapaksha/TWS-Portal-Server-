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
 * Aggregates database rows into an O(1) lookup Map
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

    // Define Role Permissions
    const managementRoles = ['SUPER ADMIN', 'SUPERVISORS', 'ER', 'ADMIN', 'TPS'];
    const selfOnlyRoles = ['LD', 'EMPLOYEES', 'EMPLOYEE'];

    // Strict validation guard fallback
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
        // Query your local MySQL instead of Supabase
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

    // Enforce dynamic checking rules safely
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
        // 1. Fetch Project Configuration Rules
        const [projRows] = await mysqlPool.query(
            'SELECT bonus_tiers FROM projects WHERE name = ? LIMIT 1',
            [project]
        );

        if (!projRows || projRows.length === 0) {
            return res.status(404).json({ success: false, error: `Configuration rules for project '${project}' not found.` });
        }

        // Parse bonus JSON tier structure out safely if kept as a string blob or native json type field
        let bonusTiers = projRows[0].bonus_tiers;
        if (typeof bonusTiers === 'string') {
            try { bonusTiers = JSON.parse(bonusTiers); } catch(e) { bonusTiers = []; }
        }

        // 2. Fetch Performance Metrics Concurrently using Promise.all on local pool
        const [exclusionsRes, ordersRes, mistakesRes] = await Promise.all([
            mysqlPool.query('SELECT excluded_date FROM employee_exclusions WHERE employee_id = ? AND excluded_date BETWEEN ? AND ?', [cleanId, startDate, endDate]),
            mysqlPool.query('SELECT order_count, date FROM orders WHERE employee_id = ? AND date BETWEEN ? AND ?', [cleanId, startDate, endDate]),
            mysqlPool.query('SELECT count, date FROM mistakes WHERE employeeid = ? AND date BETWEEN ? AND ?', [cleanId, startDate, endDate])
        ]);

        const excludedSet = new Set(exclusionsRes[0]?.map(e => normalizeDate(e.excluded_date)) || []);
        const ordersMap = aggregateToMap(ordersRes[0], 'date', 'order_count');
        const mistakesMap = aggregateToMap(mistakesRes[0], 'date', 'count');

        const dailyBreakdown = [];
        let totalOrders = 0;
        let totalMistakes = 0;
        let activeDaysCount = 0;
        
        let curr = new Date(startDate);
        const last = new Date(endDate);

        while (curr <= last) {
            const dateStr = normalizeDate(curr);
            const isExcluded = excludedSet.has(dateStr);
            const dailyOrders = ordersMap.get(dateStr) || 0;
            const dailyMistakes = mistakesMap.get(dateStr) || 0;
            const dailyNet = isExcluded ? 0 : (dailyOrders - (dailyMistakes * 5));
            
            if (!isExcluded) {
                totalOrders += dailyOrders;
                totalMistakes += dailyMistakes;
                activeDaysCount++;
            }

            dailyBreakdown.push({
                date: dateStr,
                orders: dailyOrders,
                mistakes: dailyMistakes,
                net: dailyNet,
                status: isExcluded ? 'Excluded' : 'Active'
            });

            curr.setUTCDate(curr.getUTCDate() + 1);
        }

        const totalPerformance = totalOrders - (totalMistakes * 5);
        const tiers = Array.isArray(bonusTiers) ? bonusTiers : [];

        const currentTier = [...tiers]
            .sort((a, b) => b.threshold - a.threshold) 
            .find(t => totalPerformance >= t.threshold);

        const nextTier = [...tiers]
            .sort((a, b) => a.threshold - b.threshold) 
            .find(t => t.threshold > totalPerformance);

        return res.status(200).json({
            success: true,
            summary: {
                employeeId: cleanId,
                employeeName,
                project,
                durationDays: activeDaysCount, 
                calculatedBonus: currentTier ? currentTier.bonus : 0,
                metrics: {
                    totalOrders,
                    totalMistakes,
                    totalNet: totalPerformance,
                    nextTierInfo: nextTier ? {
                        nextThreshold: nextTier.threshold,
                        gapToNext: nextTier.threshold - totalPerformance,
                        potentialBonus: nextTier.bonus
                    } : null
                },
                dailyBreakdown
            }
        });

    } catch (error) {
        console.error("Calculation Engine Processing Fault:", error);
        return res.status(500).json({ success: false, error: "Internal server error running multi-project calculation engine." });
    }
});

module.exports = router;