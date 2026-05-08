const express = require('express');
const router = require('express').Router();
const db = require('../mysqlClient');

router.get('/', async (req, res) => {
    const { auth, employee_id } = req.query;

    // --- HARDCODED SPECIAL EMPLOYEES ---
    // Add the specific IDs here that should not follow shift rules
    const specialEmployeeIds = ['1001', '1003']; 
    const isSpecial = specialEmployeeIds.includes(String(employee_id));

    try {
        let query;
        let queryParams = [];

        const getShiftSql = (dateCol, empIdCol) => `
            JSON_UNQUOTE(
                JSON_EXTRACT(
                    sa.assignments, 
                    CONCAT('$.', CAST(${empIdCol} AS CHAR), '.', CAST(DAY(${dateCol}) AS CHAR))
                )
            )
        `;

        if (auth === 'SUPER ADMIN') {
            /**
             * SUPER ADMIN VIEW: Raw Activity Stream
             * Filters duplicates and labels special employees as N/A status.
             */
            query = `
                SELECT 
                    id, employee_id, employee_name, date, 
                    check_in_time, check_out_time, shift_name,
                    /* Hardcoded logic for Super Admin view status */
                    CASE 
                        WHEN employee_id IN (${specialEmployeeIds.map(id => `'${id}'`).join(',')}) THEN 'N/A'
                        ELSE status
                    END as status
                FROM (
                    SELECT 
                        ci.id, ci.employee_id, ci.employee_name,
                        DATE_FORMAT(ci.timestamp, '%d %M %Y') as date,
                        TIME_FORMAT(ci.timestamp, '%h:%i %p') as check_in_time,
                        '--:--' as check_out_time,
                        COALESCE(${getShiftSql('ci.timestamp', 'ci.employee_id')}, 'N/A') as shift_name,
                        'CHECK-IN' as status,
                        ci.timestamp as raw_time
                    FROM attendance_logs_check_in ci
                    LEFT JOIN shift_assignments sa ON sa.month_year = DATE_FORMAT(ci.timestamp, '%Y-%m')
                    
                    UNION ALL
                    
                    SELECT 
                        co.id, co.employee_id, co.employee_name,
                        DATE_FORMAT(co.timestamp, '%d %M %Y') as date,
                        '--:--' as check_in_time,
                        TIME_FORMAT(co.timestamp, '%h:%i %p') as out_time,
                        COALESCE(${getShiftSql('co.timestamp', 'co.employee_id')}, 'N/A') as shift_name,
                        'CHECK-OUT' as status,
                        co.timestamp as raw_time
                    FROM attendance_logs_check_out co
                    LEFT JOIN shift_assignments sa ON sa.month_year = DATE_FORMAT(co.timestamp, '%Y-%m')
                ) combined_logs
                GROUP BY employee_id, raw_time, status 
                ORDER BY raw_time DESC
                LIMIT 50
            `;
        } else {
            if (!employee_id) return res.status(400).json({ success: false, message: "ID required" });

            /**
             * EMPLOYEE VIEW: 
             * If the ID is in the special list, we return 'N/A' for status.
             */
            query = `
                SELECT 
                    d.date,
                    TIME_FORMAT(ci.timestamp, '%h:%i %p') as check_in_time,
                    TIME_FORMAT(co.timestamp, '%h:%i %p') as check_out_time,
                    d.shift_code as shift_name,
                    CASE 
                        /* Check if employee is in the hardcoded special list */
                        WHEN ? IN (${specialEmployeeIds.map(id => `'${id}'`).join(',')}) THEN 'N/A'
                        WHEN ci.timestamp IS NOT NULL AND co.timestamp IS NOT NULL THEN 'Completed'
                        WHEN ci.timestamp IS NOT NULL THEN 'Check-in Only'
                        WHEN co.timestamp IS NOT NULL THEN 'Check-out Only'
                        WHEN d.shift_code = 'RD' THEN 'Off Day'
                        ELSE 'Absent'
                    END as status
                FROM (
                    SELECT 
                        days.curr_date as date,
                        ${getShiftSql('days.curr_date', '?')} as shift_code
                    FROM (
                        SELECT CURDATE() - INTERVAL (a.a + (10 * b.b)) DAY as curr_date
                        FROM (SELECT 0 as a UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS a
                        CROSS JOIN (SELECT 0 as b UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3) AS b
                    ) days
                    LEFT JOIN shift_assignments sa ON sa.month_year = DATE_FORMAT(days.curr_date, '%Y-%m')
                    WHERE days.curr_date <= CURDATE()
                ) d
                LEFT JOIN attendance_logs_check_in ci ON ci.employee_id = ? 
                    AND DATE(ci.timestamp) = d.date
                LEFT JOIN attendance_logs_check_out co ON co.employee_id = ? 
                    AND (
                        (d.shift_code = 'C' AND DATE(co.timestamp) = DATE_ADD(d.date, INTERVAL 1 DAY)) OR
                        (d.shift_code IN ('A', 'B', 'Night') AND DATE(co.timestamp) = d.date)
                    )
                WHERE d.shift_code IS NOT NULL
                ORDER BY d.date DESC 
                LIMIT 31
            `;
            queryParams = [employee_id, employee_id, employee_id, employee_id];
        }

        const [rows] = await db.query(query, queryParams);
        res.json({ success: true, data: rows });

    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});



module.exports = router;