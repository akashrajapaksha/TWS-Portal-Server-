// middleware/authMiddleware.js
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        // We assume you are passing the user role in the headers or session
        // For now, let's look for 'x-user-role' header (you can change this to JWT later)
        const userRole = req.headers['x-user-role']; 

        if (!userRole) {
            return res.status(401).json({ success: false, message: "Unauthorized. No role provided." });
        }

        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ 
                success: false, 
                message: `Access Denied. Required: ${allowedRoles.join(' or ')}` 
            });
        }

        next(); // User has the correct role, proceed to the route
    };
};

module.exports = { authorize };