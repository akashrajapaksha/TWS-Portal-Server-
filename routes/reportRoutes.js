const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');

/**
 * GET: Performance Report Data
 * Logic: 
 * - Employees: Can only see their own data based on logged-in ID.
 * - Others: Can search for any employee using 'searchId'.
 */
router.get('/performance', async (req, res) => {
    try {
        const { userRole, loggedInEmployeeId, searchId, fromDate, toDate } = req.query;

        // Determine the target ID based on the permission matrix
        let targetEmployeeId;

        if (userRole === 'Employees') {
            // Requirement: "only relevant user data show"
            targetEmployeeId = loggedInEmployeeId;
        } else {
            // Requirement: "can search any employee"
            // If searchId is provided by admin/supervisor, use it. 
            // Otherwise, it can stay undefined to fetch global data (if needed)
            targetEmployeeId = searchId || null;
        }

        // 1. Build Queries
        let orderQuery = supabase.from('orders').select('*');
        let mistakeQuery = supabase.from('mistakes').select('*');

        // Apply Targeted ID Filter
        if (targetEmployeeId) {
            orderQuery = orderQuery.eq('employee_id', targetEmployeeId);
            mistakeQuery = mistakeQuery.eq('employeeid', targetEmployeeId);
        }

        // Apply Date Range Filters
        if (fromDate) {
            orderQuery = orderQuery.gte('date', fromDate);
            mistakeQuery = mistakeQuery.gte('date', fromDate);
        }
        if (toDate) {
            orderQuery = orderQuery.lte('date', toDate);
            mistakeQuery = mistakeQuery.lte('date', toDate);
        }

        const [ordersRes, mistakesRes] = await Promise.all([orderQuery, mistakeQuery]);

        if (ordersRes.error) throw ordersRes.error;
        if (mistakesRes.error) throw mistakesRes.error;

        const orderData = ordersRes.data || [];
        const rawMistakeData = mistakesRes.data || [];

        // 2. Data Categorization (Financial vs General)
        const financialMistakes = rawMistakeData.filter(m => 
            m.mistake_type === 'MONEY SHORT' || m.mistake_type === 'DOUBLE PAY'
        );

        const generalMistakes = rawMistakeData.filter(m => 
            m.mistake_type !== 'MONEY SHORT' && m.mistake_type !== 'DOUBLE PAY'
        );

        // 3. Calculation Logic
        const totalOrders = orderData.reduce((sum, o) => sum + (Number(o.order_count) || 0), 0);
        const generalMistakesCount = generalMistakes.reduce((sum, m) => sum + (Number(m.count) || 0), 0);
        
        // Financial entries count as 1 incident each toward the count total
        const financialMistakeEntries = financialMistakes.length;

        const totalMistakesCalculated = generalMistakesCount + financialMistakeEntries;
        const totalMyrLoss = financialMistakes.reduce((sum, m) => sum + (Number(m.amount) || 0), 0);

        // Score: Total Orders - Total Mistakes
        const overallPerformance = totalOrders - totalMistakesCalculated;

        // 4. Response
        res.json({
            success: true,
            employeeName: orderData[0]?.employee_name || rawMistakeData[0]?.employee_name || "N/A",
            orderRecords: orderData,
            mistakeRecords: generalMistakes,
            financialMistakes,
            stats: {
                totalOrders,
                totalMistakes: totalMistakesCalculated,
                totalMyrLoss,
                overallPerformance 
            }
        });

    } catch (err) {
        console.error("Performance Report Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;