// Vercel serverless entry point. vercel.json rewrites every non-static path here, and the
// original URL (/slots, /bookings/:id, /proxy/..., ...) is preserved for Express to route.
// The module (and its pg Pool) is loaded once per instance and reused by warm invocations.
module.exports = require('../src/app');
