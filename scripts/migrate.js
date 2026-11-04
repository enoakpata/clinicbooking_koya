// Creates / updates the database schema. Run once per database: `npm run migrate`.
// Uses DATABASE_URL from the environment (or .env).
require('dotenv').config();
const db = require('../src/middleware/db');
const { migrate } = require('../src/schema');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

migrate(db.pool)
  .then(() => console.log(`Migration complete on ${new URL(process.env.DATABASE_URL).hostname}`))
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
