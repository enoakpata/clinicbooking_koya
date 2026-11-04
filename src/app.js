const path = require('path');
const express = require('express');
const slotsRouter = require('./routes/slots');
const bookingRouter = require('./routes/booking');
const { requireApiKey } = require('./middleware/auth');
const { notFound, errorHandler } = require('./errors');

// Endpoints the web page may reach through the proxy. /reset is deliberately excluded
// so visitors to the page can't wipe the data.
const PROXY_ALLOWED = [
  ['GET', /^\/slots\/?$/],
  ['POST', /^\/bookings\/?$/],
  ['GET', /^\/bookings\/[^/]+\/?$/],
];

function apiRouter() {
  const api = express.Router();
  api.use(requireApiKey); // auth first: unauthenticated requests get 401, even for unknown routes
  api.use(express.json({ limit: '100kb' }));
  api.use(slotsRouter);
  api.use(bookingRouter);
  api.use(notFound);
  return api;
}

// The Express app. No app.listen() here: src/server.js listens locally, api/index.js hands the
// app to Vercel. Nothing is kept in memory between requests; all state is in Postgres.
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple'); // ?a[b]=c stays a plain string key, no nested objects

  // Web page + favicon (no API key in them). On Vercel these are normally served from the CDN
  // before the rewrite to the function; this covers local runs and any request that reaches the app.
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', redirect: false }));

  const api = apiRouter();

  // Server-side proxy for the page: adds the API key, then runs the API router in-process
  // (no HTTP call to localhost, so it works the same on Vercel).
  app.use('/proxy', (req, res, next) => {
    const allowed = PROXY_ALLOWED.some(([m, re]) => m === req.method && re.test(req.path));
    if (!allowed) return notFound(req, res);
    req.headers['x-api-key'] = process.env.API_KEY || '';
    api(req, res, next);
  });

  app.use(api);
  app.use(errorHandler);
  return app;
}

module.exports = createApp();
