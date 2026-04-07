const express = require('express');
const cors = require('cors');
const supabase = require('./supabaseClient');

// --- ROUTE IMPORTS ---
const authRoutes = require('./routes/authRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const orderRoutes = require('./routes/orderRoutes');
const projectRoutes = require('./routes/projectRoutes');
const mistakeRoutes = require('./routes/mistakeRoutes');
const irRoutes = require('./routes/irRoutes');
const warningRoutes = require('./routes/warningRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes'); // ✅ NEW: For the Analyzing.tsx component
const reportRoutes = require('./routes/reportRoutes');
const leaveRoutes = require('./routes/leaveRoutes');
const leaveLOGRoutes = require("./routes/leaveLOGRoutes");
const bonusRoutes = require('./routes/bonusRoutes');
const logRoutes = require('./routes/logRoutes');
const otherLogRoutes = require('./routes/otherLogRoutes');
const feedbackRoutes = require("./routes/feedbackRoutes");

const app = express();

// --- 1. SETTINGS & SECURITY ---
app.set('trust proxy', true);

// --- 2. CORS CONFIGURATION ---
const allowedOrigins = [
    'http://localhost:3000', 
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://tws.portal.ceyloncreative.site'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(new Error('CORS policy violation'), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-role', 'x-employee-id'],
    credentials: true
}));

// --- 3. GLOBAL MIDDLEWARE ---
app.use(express.json());

// --- 4. HEALTH CHECK ---
app.get('/api/test-connection', async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('employees')
            .select('*', { count: 'exact', head: true });
        
        if (error) throw error;
        res.json({ success: true, message: "Backend Live & Supabase Connected", rowCount: count || 0 });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- 5. REGISTERED ROUTES ---
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/analytics', analyticsRoutes); // ✅ NEW: Handles the performance cross-referencing
app.use('/api/orders', orderRoutes);
app.use('/api/mistakes', mistakeRoutes);
app.use('/api/ir', irRoutes);
app.use('/api/warnings', warningRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/leave-logs', leaveLOGRoutes);
app.use('/api/bonus', bonusRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/other-logs', otherLogRoutes);

// --- 6. ERROR HANDLING ---
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found.` });
});

app.use((err, req, res, next) => {
    console.error("SERVER_ERROR:", err.stack);
    res.status(500).json({ success: false, message: "Internal Server Error" });
});

// --- 7. START SERVER ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`
    🚀 TWS PORTAL BACKEND: ONLINE
    --------------------------------------------
    📡 Local:            http://localhost:${PORT}
    📊 Analytics API:     http://localhost:${PORT}/api/analytics/search
    💬 Feedback API:      http://localhost:${PORT}/api/feedback
    --------------------------------------------
    `);
});