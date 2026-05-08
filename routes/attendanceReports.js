const express = require('express');
const router = express.Router();
const db = require('../mysqlClient');
const supabase = require('../supabaseClient');

router.get('/generate', async (req, res) => {
    const { employee_id, start_date, end_date } = req.query;

    if (!employee_id || !start_date || !end_date) {
        return res.status(400).json({ success: false, message: "Missing required parameters" });
    }

    try {
        // --- 1. GET EARLIEST PUNCH PER DAY ---
        // We use MIN(timestamp) and GROUP BY DATE(timestamp) to merge duplicate scans 
        // occurring on the same day into a single record.
        const checkInQuery = `
            SELECT 
                DATE(ci.timestamp) as punch_date,
                MIN(ci.timestamp) as first_punch,
                JSON_UNQUOTE(
                    JSON_EXTRACT(
                        sa.assignments, 
                        CONCAT('$.', CAST(ci.employee_id AS CHAR), '.', CAST(DAY(ci.timestamp) AS CHAR))
                    )
                ) as shift_code
            FROM attendance_logs_check_in ci
            LEFT JOIN shift_assignments sa ON sa.month_year = DATE_FORMAT(ci.timestamp, '%Y-%m')
            WHERE ci.employee_id = ? 
            AND DATE(ci.timestamp) BETWEEN ? AND ?
            GROUP BY punch_date, shift_code
        `;

        // --- 2. GET OVERTIME (OT) ---
        // Calculates hours worked beyond the 9-hour standard shift.
        const otQuery = `
            SELECT 
                SUM(GREATEST(0, TIMESTAMPDIFF(HOUR, ci.timestamp, co.timestamp) - 9)) as totalOT
            FROM attendance_logs_check_in ci
            JOIN attendance_logs_check_out co ON ci.employee_id = co.employee_id 
                AND DATE(ci.timestamp) = DATE(co.timestamp)
            WHERE ci.employee_id = ? 
            AND DATE(ci.timestamp) BETWEEN ? AND ?
        `;

        const [checkInRows] = await db.query(checkInQuery, [employee_id, start_date, end_date]);
        const [otRows] = await db.query(otQuery, [employee_id, start_date, end_date]);

        // --- 3. CALCULATE LATES (STRICT 05:31 AM CUTOFF) ---
        let totalLates = 0;
        
        /**
         * To be 100% safe from duplicates, we use a Map.
         * Key: Date String (e.g., "2026-05-06")
         * Value: The earliest punch record for that day.
         */
        const dailyFirstPunches = new Map();

        checkInRows.forEach(row => {
            const dateKey = new Date(row.first_punch).toISOString().split('T')[0];
            
            // If we haven't recorded a punch for this date yet, add it.
            if (!dailyFirstPunches.has(dateKey)) {
                dailyFirstPunches.set(dateKey, row);
            }
        });

        // Now evaluate the unique daily punches against shift thresholds
        dailyFirstPunches.forEach((record) => {
            const punchTime = new Date(record.first_punch);
            const checkInMinutes = (punchTime.getHours() * 60) + punchTime.getMinutes();
            
            // Default to 'A' (Morning) if no shift code is found
            const shift = record.shift_code ? String(record.shift_code).trim().toUpperCase() : 'A';

            /**
             * THRESHOLDS (Total Minutes from Midnight)
             * A / MORNING:   05:31 AM = 331 mins (Late if > 331)
             * B / AFTERNOON: 01:31 PM = 811 mins (Late if > 811)
             * C / NIGHT:     09:31 PM = 1291 mins (Late if > 1291)
             */
            if ((shift === 'A' || shift === 'MORNING') && checkInMinutes > 331) {
                totalLates++;
            } 
            else if ((shift === 'B' || shift === 'AFTERNOON') && checkInMinutes > 811) {
                totalLates++;
            } 
            else if ((shift === 'C' || shift === 'NIGHT') && checkInMinutes > 1291) {
                totalLates++;
            }
        });

        // --- 4. GET APPROVED LEAVES (SUPABASE) ---
        const [res1, res2] = await Promise.all([
            supabase.from('leave_applications')
                .select('number_of_days')
                .eq('employee_id', employee_id)
                .eq('status', 'Approved')
                .gte('start_date', start_date)
                .lte('end_date', end_date),
            supabase.from('leave_applications_two')
                .select('number_of_days')
                .eq('employee_id', employee_id)
                .eq('status', 'Approved')
                .gte('start_date', start_date)
                .lte('end_date', end_date)
        ]);

        const totalLeaves = [...(res1.data || []), ...(res2.data || [])]
            .reduce((sum, item) => sum + item.number_of_days, 0);

        // --- 5. FINAL RESPONSE ---
        res.json({
            success: true,
            data: {
                totalOT: otRows[0]?.totalOT || 0,
                totalLates: totalLates,
                totalLeaves: totalLeaves || 0
            }
        });

    } catch (err) {
        console.error("Report Generation Error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

module.exports = router;