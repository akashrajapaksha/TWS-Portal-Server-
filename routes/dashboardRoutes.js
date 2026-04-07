const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');
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

        const { data: allowedNetworks } = await supabase
            .from('allowed_networks')
            .select('cidr_range');

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
        
        // Define the role groups
        const globalRoles = ['SUPER ADMIN', 'ADMIN', 'ER', 'SUPERVISORS'];
        const limitedAuthorityRoles = ['TPS', 'TL', 'TSP', 'LD'];
        
        // Check permissions
        const hasGlobalVisibility = globalRoles.includes(role);
        const isAuthority = hasGlobalVisibility || limitedAuthorityRoles.includes(role);
        
        const today = new Date().toISOString().split('T')[0];
        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(employeeId);
        
        let profileQuery = supabase.from('employees').select('id, project, employee_id, department');
        if (isUuid) { profileQuery = profileQuery.eq('id', employeeId); } 
        else { profileQuery = profileQuery.eq('employee_id', employeeId.toUpperCase()); }

        const { data: userProfile, error: userError } = await profileQuery.maybeSingle();

        if (userError) throw userError;
        if (!userProfile) return res.status(404).json({ error: "Employee profile not found" });

        const [ordersRes, mistakesRes] = await Promise.all([
            supabase.from('orders').select('order_count').eq('employee_id', userProfile.id),
            supabase.from('mistakes').select('mistake_type, amount, count').eq('employeeid', userProfile.id)
        ]);

        // --- LEAVE FILTER LOGIC ---
        let l1Query = supabase.from('leave_applications').select('*').gte('start_date', today).eq('status', 'Approved');
        let l2Query = supabase.from('leave_applications_two').select('*').gte('start_date', today).eq('status', 'Approved');

        if (!hasGlobalVisibility) {
            let visibilityIds = [userProfile.id]; 

            if (userProfile.project) {
                const { data: projectTeam } = await supabase.from('employees').select('id').eq('project', userProfile.project);
                if (projectTeam && projectTeam.length > 0) {
                    visibilityIds = projectTeam.map(m => m.id);
                }
            } 
            else if (userProfile.department && userProfile.department.toUpperCase() !== 'DATA ENTRY') {
                const { data: deptTeam } = await supabase.from('employees').select('id').eq('department', userProfile.department);
                if (deptTeam && deptTeam.length > 0) {
                    visibilityIds = deptTeam.map(m => m.id);
                }
            }

            l1Query = l1Query.in('employee_id', visibilityIds);
            l2Query = l2Query.in('employee_id', visibilityIds);
        }

        const [l1Res, l2Res] = await Promise.all([l1Query, l2Query]);
        if (l1Res.error) throw l1Res.error;
        if (l2Res.error) throw l2Res.error;

        const totalOrders = (ordersRes.data || []).reduce((sum, o) => sum + (Number(o.order_count) || 0), 0);
        const totalMistakes = (mistakesRes.data || []).reduce((sum, m) => sum + (Number(m.count) || 0), 0);
        const totalMyrLoss = (mistakesRes.data || []).reduce((sum, m) => {
            if (['MONEY SHORT', 'DOUBLE PAY'].includes(m.mistake_type?.toUpperCase())) {
                return sum + (Number(m.amount) || 0);
            }
            return sum;
        }, 0);

        const rawLeaves = [...(l1Res.data || []), ...(l2Res.data || [])];
        let upcomingLeaves = [];

        if (rawLeaves.length > 0) {
            const uniqueEmpIds = [...new Set(rawLeaves.map(l => l.employee_id))];
            const { data: empProjects } = await supabase.from('employees').select('id, project').in('id', uniqueEmpIds);
            const projectMap = Object.fromEntries(empProjects?.map(e => [e.id, e.project]) || []);

            upcomingLeaves = rawLeaves.map(leave => ({
                ...leave,
                project: projectMap[leave.employee_id] || 'General' 
            })).sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
        }

        let responseData = {
            totalOrders,
            totalMistakes,
            totalMyrLoss,
            overallPerformance: totalOrders - (totalMistakes * 2),
            upcomingLeaves,
            totalEmployees: 0
        };

        if (isAuthority) {
            const { count } = await supabase.from('employees').select('*', { count: 'exact', head: true }).not('role', 'ilike', '%Super Admin%');
            responseData.totalEmployees = count || 0;
        }

        return res.status(200).json(responseData);

    } catch (error) {
        console.error("Dashboard Route Error Detail:", error);
        return res.status(500).json({ error: error.message || "Internal Server Error" });
    }
});

/**
 * Search Employee Logic
 */
router.get('/search/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('employees')
            .select('id, name, employee_id, initials') 
            .eq('employee_id', req.params.id.toUpperCase())
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: "Employee not found" });
        
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: "Search failed" });
    }
});

module.exports = router;