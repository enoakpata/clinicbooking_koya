require('dotenv').config();
const db = require('./middleware/db');
const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;

db.init()
  .then(() => {
    createApp().listen(PORT, () => console.log(`Listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialise database', err);
    process.exit(1);
  });
