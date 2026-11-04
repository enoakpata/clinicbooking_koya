// Local development server only (Vercel uses api/index.js). Run `npm run migrate` once first.
require('dotenv').config(); // must load before the app, which creates the DB pool from DATABASE_URL
const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
