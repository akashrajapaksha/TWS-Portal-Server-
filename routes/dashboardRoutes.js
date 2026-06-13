const express = require('express');
const router = express.Router();
const db = require('../db'); // ✅ Local MySQL Client configuration
const rangeCheck = require('range_check');

/**
 * IP Access Validation
 */
async function validateIpAccess(userRole, clientIp) {
    let cleanIp = clientIp;
    if (cleanIp.includes(',')) cleanIp = cleanIp.split(',')[0].trim();
    if (cleanIp.startsWith('::ffff:')) cleanIp = cleanIp.replace('::ffff:', '');

    if (userRole?.toUpperCase().trim() === 'SUPER ADMIN') return true;

    const internalRange = ['192.188.1.0/24', '::1', '127.0.0.1']; 

    try {
        const isInternal = rangeCheck.inRange(cleanIp, internalRange);
        if (isInternal) return true;

        const [allowedNetworks] = await db.query('SELECT cidr_range FROM allowed_networks');

        if (allowedNetworks && allowedNetworks.length > 0) {
            const extraRanges = allowedNetworks.map(n => n.cidr_range);
            return rangeCheck.inRange(cleanIp, extraRanges);
        }
        return false; 
    } catch (err) {
        return false;
    }
}

/**
 * Dashboard Statistics & Team Leave Schedule
 */
router.get('/stats', async (req, res) => {
    const { employeeId, userRole } = req.query; 
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!employeeId || employeeId === 'undefined') {
        return res.status(400).json({ error: "Valid Employee Identifier is required" });
    }

    try {
        const isAuthorizedIp = await validateIpAccess(userRole, clientIp);
        if (!isAuthorizedIp) {
            return res.status(403).json({ error: `Access Denied: IP ${clientIp} unauthorized.` });
        }

        const role = userRole?.toUpperCase().trim();
        
        // Define authority role groups
        const globalRoles = ['SUPER ADMIN', 'ADMIN', 'ER', 'SUPERVISORS'];
        const limitedAuthorityRoles = ['TPS', 'TL', 'TSP', 'LD'];
        const isAuthority = globalRoles.includes(role) || limitedAuthorityRoles.includes(role);
        
        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(employeeId);
        
        // --- 1. GET USER PROFILE ---
        let profileQuery = 'SELECT id, name, project, employee_id, department, role FROM employees WHERE ';
        profileQuery += isUuid ? 'id = ?' : 'employee_id = ?';
        const profileParam = isUuid ? employeeId : employeeId.toUpperCase().trim();

        const [profileRows] = await db.query(profileQuery, [profileParam]);
        const userProfile = profileRows[0];

        if (!userProfile) return res.status(404).json({ error: "Employee profile not found" });

        // --- 2. TIME ENGINE (SRI LANKA SHIFT SCHEDULER) ---
        const lankaString = new Date().toLocaleString("en-US", { timeZone: "Asia/Colombo" });
        const lankaDate = new Date(lankaString);

        // Safe YYYY-MM-DD date representation in Sri Lanka timezone
        const currentShiftDate = lankaDate.toLocaleDateString('en-CA'); 

        // Extract clock variables for matching windows
        const hours = lankaDate.getHours();
        const minutes = lankaDate.getMinutes();
        const totalMinutes = (hours * 60) + minutes;

        // Evaluate shift strings matching database syntax
        let currentShift = 'NIGHT';
        if (totalMinutes >= 330 && totalMinutes < 810) {
            currentShift = 'MORNING';
        } else if (totalMinutes >= 810 && totalMinutes < 1290) {
            currentShift = 'AFTERNOON';
        }

        // --- 3. DETERMINING CONDITIONAL SCOPE FOR ORDERS & MISTAKES ---
        let ordersRows = [];
        let mistakesRows = [];

        const isAuthorityViewingSelf = isAuthority && (userProfile.employee_id === '001' || userProfile.department === 'IT' || userProfile.role?.toUpperCase().includes('SUPER ADMIN'));

        if (isAuthorityViewingSelf) {
            const [[allOrders], [allMistakes]] = await Promise.all([
                db.query('SELECT order_count FROM orders'),
                db.query('SELECT mistake_type, amount, count FROM mistakes')
            ]);
            ordersRows = allOrders;
            mistakesRows = allMistakes;
        } else {
            const [[indivOrders], [indivMistakes]] = await Promise.all([
                db.query('SELECT order_count FROM orders WHERE TRIM(CAST(employee_id AS CHAR)) = TRIM(CAST(? AS CHAR))', [userProfile.employee_id]),
                db.query('SELECT mistake_type, amount, count FROM mistakes WHERE TRIM(CAST(employeeid AS CHAR)) = TRIM(CAST(? AS CHAR))', [userProfile.employee_id])
            ]);
            ordersRows = indivOrders;
            mistakesRows = indivMistakes;
        }

        // --- 4. LEAVE FILTER VISIBILITY RESOLUTION ---
        let visibilityIds = [];
        const hasGlobalVisibility = globalRoles.includes(role);

        if (hasGlobalVisibility) {
            const [allStaff] = await db.query('SELECT id FROM employees');
            visibilityIds = allStaff.map(m => m.id);
        } else {
            const projectTarget = userProfile.project || '';
            const [projectTeam] = await db.query('SELECT id FROM employees WHERE project = ? AND project != ""', [projectTarget]);
            
            if (projectTeam && projectTeam.length > 0) {
                visibilityIds = projectTeam.map(m => m.id);
            } else {
                visibilityIds = [userProfile.id];
            }
        }

        // --- 5. EXECUTE LEAVE QUERIES ---
        let l1Query = 'SELECT * FROM leave_applications WHERE start_date >= ? AND status = "Approved"';
        let l2Query = 'SELECT * FROM leave_applications_two WHERE start_date >= ? AND status = "Approved"';
        let l1Params = [currentShiftDate];
        let l2Params = [currentShiftDate];

        if (visibilityIds.length > 0) {
            l1Query += ' AND employee_id IN (?)';
            l2Query += ' AND employee_id IN (?)';
            l1Params.push(visibilityIds);
            l2Params.push(visibilityIds);
        } else {
            l1Query += ' AND 1=0';
            l2Query += ' AND 1=0';
        }

        const [[l1Rows], [l2Rows]] = await Promise.all([
            db.query(l1Query, l1Params),
            db.query(l2Query, l2Params)
        ]);

        const totalOrders = (ordersRows || []).reduce((sum, o) => sum + (Number(o.order_count) || 0), 0);
        const totalMistakes = (mistakesRows || []).reduce((sum, m) => sum + (Number(m.count) || 0), 0);
        const totalMyrLoss = (mistakesRows || []).reduce((sum, m) => {
            if (['MONEY SHORT', 'DOUBLE PAY'].includes(m.mistake_type?.toUpperCase().trim())) {
                return sum + (Number(m.amount) || 0);
            }
            return sum;
        }, 0);

        const rawLeaves = [...(l1Rows || []), ...(l2Rows || [])];
        let upcomingLeaves = [];

        if (rawLeaves.length > 0) {
            const uniqueEmpIds = [...new Set(rawLeaves.map(l => l.employee_id))];
            const [empProjects] = await db.query('SELECT id, project, name FROM employees WHERE id IN (?)', [uniqueEmpIds]);
            const projectMap = Object.fromEntries(empProjects?.map(e => [e.id, e.project]) || []);
            const nameMap = Object.fromEntries(empProjects?.map(e => [e.id, e.name]) || []);

            upcomingLeaves = rawLeaves.map(leave => ({
                ...leave,
                employee_name: leave.employee_name || nameMap[leave.employee_id] || 'Staff User',
                project: projectMap[leave.employee_id] || 'General' 
            })).sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());
        }

        // --- 6. PRIMARY TOP PERFORMER SEARCH ENGINE ---
        // Updated to use 'e.profile_image' based on the database layout schema
        let topPerformerQuery = `
            SELECT 
                e.name, 
                e.project, 
                e.profile_image, 
                SUM(o.order_count) AS total_orders,
                DATE_FORMAT(o.date, '%Y-%m-%d') as record_date,
                UPPER(TRIM(o.shift)) as record_shift
            FROM employees e
            JOIN orders o ON TRIM(CAST(e.employee_id AS CHAR)) = TRIM(CAST(o.employee_id AS CHAR))
        `;
        
        let topPerformerParams = [];
        
        if (!isAuthorityViewingSelf && userProfile.project) {
            topPerformerQuery += ' WHERE e.project = ? AND o.date = ? AND UPPER(TRIM(o.shift)) = ? ';
            topPerformerParams.push(userProfile.project, currentShiftDate, currentShift);
        } else {
            topPerformerQuery += ' WHERE o.date = ? AND UPPER(TRIM(o.shift)) = ? ';
            topPerformerParams.push(currentShiftDate, currentShift);
        }
        
        topPerformerQuery += `
            GROUP BY e.id, e.name, e.project, e.profile_image, o.date, o.shift
            ORDER BY total_orders DESC 
            LIMIT 1
        `;

        let [topRows] = await db.query(topPerformerQuery, topPerformerParams);
        let finalTopPerformer = null;

        if (topRows && topRows.length > 0) {
            finalTopPerformer = {
                name: topRows[0].name,
                project: topRows[0].project || 'General',
                profilePhoto: topRows[0].profile_image || '', // Maps to standard UI profilePhoto variable
                ordersCount: Number(topRows[0].total_orders) || 0,
                date: topRows[0].record_date,
                shift: topRows[0].record_shift,
                isHistorical: false
            };
        } else {
            // Fallback Logic: Current shift records don't exist yet; find the most recent entries
            let fallbackQuery = `
                SELECT 
                    e.name, 
                    e.project, 
                    e.profile_image, 
                    SUM(o.order_count) AS total_orders,
                    o.date as record_date,
                    o.shift as record_shift
                FROM employees e
                JOIN orders o ON TRIM(CAST(e.employee_id AS CHAR)) = TRIM(CAST(o.employee_id AS CHAR))
            `;
            
            let fallbackParams = [];
            if (!isAuthorityViewingSelf && userProfile.project) {
                fallbackQuery += ' WHERE e.project = ? ';
                fallbackParams.push(userProfile.project);
            }
            
            fallbackQuery += `
                GROUP BY e.id, e.name, e.project, e.profile_image, o.date, o.shift
                ORDER BY o.date DESC, total_orders DESC
                LIMIT 1
            `;
            
            const [fallbackRows] = await db.query(fallbackQuery, fallbackParams);
            
            if (fallbackRows && fallbackRows.length > 0) {
                const dbDate = new Date(fallbackRows[0].record_date);
                const formattedDbDate = dbDate.toISOString().split('T')[0];

                finalTopPerformer = {
                    name: fallbackRows[0].name,
                    project: fallbackRows[0].project || 'General',
                    profilePhoto: fallbackRows[0].profile_image || '',
                    ordersCount: Number(fallbackRows[0].total_orders) || 0,
                    date: formattedDbDate,
                    shift: fallbackRows[0].record_shift?.toUpperCase(),
                    isHistorical: true
                };
            }
        }

        if (!finalTopPerformer) {
            finalTopPerformer = {
                name: "N/A",
                project: userProfile.project || "General",
                profilePhoto: "",
                ordersCount: 0,
                date: currentShiftDate,
                shift: currentShift,
                isHistorical: false
            };
        }

        // --- 7. CLEANED PAYLOAD RESPONSE ---
        let responseData = {
            totalOrders,
            totalMistakes,
            totalMyrLoss,
            upcomingLeaves,
            currentShift,
            topPerformer: finalTopPerformer,
            totalEmployees: 0
        };

        if (isAuthority) {
            const countQuery = 'SELECT COUNT(*) AS count FROM employees WHERE role NOT LIKE "%Super Admin%"';
            const [countRows] = await db.query(countQuery);
            responseData.totalEmployees = countRows[0]?.count || 0;
        }

        return res.status(200).json(responseData);

    } catch (error) {
        console.error("❌ CRITICAL ROUTE ERROR:", error);
        return res.status(500).json({ error: error.message || "Internal Server Error" });
    }
});

/**
 * Search Employee Logic
 */
router.get('/search/:id', async (req, res) => {
    try {
        const cleanParam = decodeURIComponent(req.params.id).toUpperCase().trim();
        
        const queryStr = `
            SELECT id, name, employee_id, initials 
            FROM employees 
            WHERE employee_id = ? OR UPPER(name) = ? 
            LIMIT 1
        `;
        const [rows] = await db.query(queryStr, [cleanParam, cleanParam]);
        const data = rows[0];

        if (!data) return res.status(404).json({ error: "Employee not found" });
        
        if (!data.initials && data.name) {
            data.initials = data.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
        }

        return res.status(200).json(data);
    } catch (error) {
        console.error("❌ SEARCH ENGINE ROUTE CRASH:", error);
        return res.status(500).json({ error: "Search failed" });
    }
});

module.exports = router;