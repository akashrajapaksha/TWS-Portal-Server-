const express = require('express');
const router = require('express').Router();
const supabase = require('../supabaseClient');

router.get('/search', async (req, res) => {
    try {
        const { mode, empId, start, end, shift, project } = req.query;

        // 1. Identify Mode
        const isAllMode = (mode === 'all');
        const cleanId = empId ? empId.trim() : null;

        // 2. Resolve Profile Identity
        let profile = { name: "Team Overview", designation: "All Departments" };

        if (!isAllMode) {
            if (!cleanId) {
                return res.status(400).json({ success: false, message: "Employee ID is required" });
            }

            const { data: empProfile, error: profileError } = await supabase
                .from('employees')
                .select('name, designation')
                .eq('employee_id', cleanId)
                .maybeSingle();

            if (profileError || !empProfile) {
                return res.status(404).json({ success: false, message: "Employee not found" });
            }
            profile = empProfile;
        }

        // 3. Optimized Filter Helper
        const applyFilters = (query, tableType) => {
            let q = query;

            // Identity Filter: Apply only if NOT in "All Employees" mode
            if (!isAllMode && cleanId) {
                const idColumn = tableType === 'ir' ? 'emp_no' : (tableType === 'mistake' ? 'employeeid' : 'employee_id');
                q = q.eq(idColumn, cleanId);
            }

            // Date Filters: Using dynamic column names based on table structure
            const dateCol = tableType === 'ir' ? 'incident_date' : (tableType === 'warn' ? 'warning_date' : 'date');
            if (start) q = q.gte(dateCol, start);
            if (end) q = q.lte(dateCol, end);

            // Project Filter: Only apply if a specific project is selected
            if (project && project !== 'All') {
                q = q.eq('project_name', project);
            }

            // Shift Filter: Only applies to performance-based tables (mistakes/orders)
            if (shift && shift !== 'All' && (tableType === 'mistake' || tableType === 'order')) {
                q = q.eq('shift', shift);
            }

            return q;
        };

        // 4. Parallel Data Fetching
        // We fetch only the necessary columns to keep the response fast
        const [irs, warns, mistakes, orders] = await Promise.all([
            applyFilters(supabase.from('incident_reports').select('id').neq('status', 'pending'), 'ir'),
            applyFilters(supabase.from('warnings').select('id').eq('status', 'Approved'), 'warn'),
            applyFilters(supabase.from('mistakes').select('mistake_type, count, amount'), 'mistake'),
            applyFilters(supabase.from('orders').select('order_count'), 'order')
        ]);

        // 5. Calculations Logic
        let totalWrongKeys = 0;
        let totalShortMoney = 0;

        mistakes.data?.forEach(m => {
            const type = (m.mistake_type || "").toUpperCase();
            // Matching your AddOrder.tsx logic for mistake categorization
            if (type.includes('WRONG KEY')) {
                totalWrongKeys += (Number(m.count) || 0);
            } else if (type.includes('SHORT') || type.includes('MONEY') || type.includes('DOUBLE') || type.includes('PAY')) {
                totalShortMoney += (Number(m.amount) || 0);
            }
        });

        const totalOrders = orders.data?.reduce((sum, row) => sum + (Number(row.order_count) || 0), 0) || 0;

        // 6. Final Response
        res.json({
            success: true,
            employee: { 
                id: isAllMode ? 'ALL' : cleanId, 
                name: profile.name, 
                position: profile.designation 
            },
            stats: {
                total_irs: irs.data?.length || 0,
                total_warnings: warns.data?.length || 0,
                total_wrong_keys: totalWrongKeys,
                total_orders: totalOrders,
                total_short_money: totalShortMoney
            }
        });

    } catch (err) {
        console.error("Analytics Engine Error:", err.message);
        res.status(500).json({ 
            success: false, 
            message: "Analytics engine failed to process the request." 
        });
    }
});

module.exports = router;