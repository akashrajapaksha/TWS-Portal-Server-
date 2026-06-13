const express = require('express');
const router = express.Router();
const mysqlPool = require('../db'); // Using your local MySQL client pool

/**
 * GET: Performance Report Data
 */
router.get('/performance', async (req, res) => {
    try {
        const { userRole, loggedInEmployeeId, searchId, fromDate, toDate } = req.query;

        // Determine the target ID based on the permission matrix
        let targetEmployeeId;
        if (userRole === 'Employees') {
            targetEmployeeId = loggedInEmployeeId;
        } else {
            targetEmployeeId = searchId || null;
        }

        // --- 1. BUILD SQL QUERIES DYNAMICALLY ---
        let orderQuery = `SELECT * FROM orders WHERE 1=1`;
        let mistakeQuery = `SELECT * FROM mistakes WHERE 1=1`;
        const orderParams = [];
        const mistakeParams = [];

        // Apply Targeted ID Filter
        if (targetEmployeeId) {
            orderQuery += ` AND employee_id = ?`;
            orderParams.push(targetEmployeeId);

            mistakeQuery += ` AND employeeid = ?`;
            mistakeParams.push(targetEmployeeId);
        }

        // Apply Date Range Filters
        if (fromDate) {
            orderQuery += ` AND date >= ?`;
            orderParams.push(fromDate);

            mistakeQuery += ` AND date >= ?`;
            mistakeParams.push(fromDate);
        }
        if (toDate) {
            orderQuery += ` AND date <= ?`;
            orderParams.push(toDate);

            mistakeQuery += ` AND date <= ?`;
            mistakeParams.push(toDate);
        }

        // Sort records sequentially by date
        orderQuery += ` ORDER BY date ASC`;
        mistakeQuery += ` ORDER BY date ASC`;

        // Execute queries concurrently using promise wrappers
        const [ordersResult, mistakesResult] = await Promise.all([
            mysqlPool.query(orderQuery, orderParams),
            mysqlPool.query(mistakeQuery, mistakeParams)
        ]);

        // mysql2 returns an array where index [0] contains the row packets
        const orderData = ordersResult[0] || [];
        const rawMistakeData = mistakesResult[0] || [];

        // --- 2. DATA CATEGORIZATION (Financial vs General) ---
        const financialMistakes = rawMistakeData.filter(m => 
            m.mistake_type === 'MONEY SHORT' || m.mistake_type === 'DOUBLE PAY'
        );

        const generalMistakes = rawMistakeData.filter(m => 
            m.mistake_type !== 'MONEY SHORT' && m.mistake_type !== 'DOUBLE PAY'
        );

        // --- 3. CALCULATION ENGINE ---
        const totalOrders = orderData.reduce((sum, o) => sum + (Number(o.order_count) || 0), 0);
        const generalMistakesCount = generalMistakes.reduce((sum, m) => sum + (Number(m.count) || 0), 0);
        
        // Financial entries count as 1 incident each toward the count total
        const financialMistakeEntries = financialMistakes.length;

        const totalMistakesCalculated = generalMistakesCount + financialMistakeEntries;
        const totalMyrLoss = financialMistakes.reduce((sum, m) => sum + (Number(m.amount) || 0), 0);

        // Score: Total Orders - Total Mistakes
        const overallPerformance = totalOrders - totalMistakesCalculated;

        // --- 4. RESPONSE ---
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