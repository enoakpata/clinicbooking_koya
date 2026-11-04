const crypto = require('crypto');

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Requires a correct X-API-Key header. Fails closed if API_KEY isn't configured.
function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  const given = req.get('X-API-Key');
  if (!expected || typeof given !== 'string' || !crypto.timingSafeEqual(digest(given), digest(expected))) {
    return res.status(401).json({ error: 'missing or invalid API key' });
  }
  next();
}

module.exports = { requireApiKey };
