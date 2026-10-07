'use strict';

const http = require('node:http');
const path = require('node:path');
const { Store } = require('./store');
const { seed } = require('./seed');
const { Platform } = require('./platform');
const { providerFromEnv } = require('./providers');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.VAS_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

const store = new Store(DATA_FILE, seed);
const platform = new Platform(store, { provider: providerFromEnv() });
const app = createApp(platform, { exposeDemoKey: process.env.NODE_ENV !== 'production' });

// Delivery engine: release scheduled campaigns, submit queued messages, collect DLRs.
const engine = setInterval(() => {
  platform.dispatch().catch((err) => console.error('dispatch error:', err));
}, 1000);

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`VAS platform running on http://localhost:${PORT}`);
  console.log(`  gateway : ${platform.provider.name}`);
  console.log(`  data    : ${DATA_FILE}`);
  console.log(`  API key : ${platform.account.apiKey}`);
});

function shutdown() {
  clearInterval(engine);
  store.flush();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
