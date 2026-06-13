// ⚠️ Temporary placeholder to prevent boot crashes while migrating routes to MySQL
console.log("⚠️ Warning: Code is still attempting to require('supabaseClient').");

// Export a dummy object so routes importing it don't immediately throw 'undefined' errors
module.exports = {
    from: () => ({
        select: () => ({ data: [], error: null }),
        insert: () => ({ data: [], error: null }),
        update: () => ({ data: [], error: null }),
        delete: () => ({ data: [], error: null }),
    })
};