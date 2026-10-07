'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ApiError } = require('./platform');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const type = req.headers['content-type'] || '';
      if (type.includes('application/x-www-form-urlencoded')) {
        return resolve(Object.fromEntries(new URLSearchParams(raw)));
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Build the request handler. `platform` holds all business logic. */
function createApp(platform, { exposeDemoKey = true } = {}) {
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, regex, keys, handler, auth });
  };

  // Public / webhook endpoints (called by the operator gateway).
  route('GET', '/api/health', () => ({ status: 'ok', provider: platform.provider.name, time: new Date().toISOString() }), { auth: false });
  if (exposeDemoKey) {
    route('GET', '/api/demo-key', () => ({ apiKey: platform.account.apiKey, account: platform.account.name }), { auth: false });
  }
  route('POST', '/api/ussd/callback', ({ body }) => platform.handleUssd(body), { auth: false });
  route('POST', '/api/sms/inbound', ({ body }) => platform.handleInbound(body), { auth: false });
  route('POST', '/api/callbacks/dlr', ({ body }) => platform.deliveryReport(body), { auth: false });

  // Account & wallet
  route('GET', '/api/account', () => {
    const { apiKey, ...acc } = platform.account;
    return { ...acc, balance: platform.balance().balance, pricing: platform.pricing, provider: platform.provider.name };
  });
  route('GET', '/api/stats', () => platform.stats());
  route('GET', '/api/wallet', () => ({ ...platform.balance(), transactions: platform.transactions() }));
  route('POST', '/api/wallet/topup', ({ body }) => platform.topUp(body));

  // Sender IDs
  route('GET', '/api/sender-ids', () => platform.store.all('senderIds'));
  route('POST', '/api/sender-ids', ({ body }) => platform.requestSenderId(body));

  // Contacts & groups
  route('GET', '/api/contacts', ({ query }) => platform.listContacts(query));
  route('POST', '/api/contacts', ({ body }) => platform.importContacts(Array.isArray(body.contacts) ? body : { contacts: [body], groupId: body.groupId }));
  route('DELETE', '/api/contacts/:id', ({ params }) => { platform.deleteContact(params.id); return { deleted: true }; });
  route('GET', '/api/groups', () => platform.listGroups());
  route('POST', '/api/groups', ({ body }) => platform.createGroup(body));
  route('DELETE', '/api/groups/:id', ({ params }) => { platform.deleteGroup(params.id); return { deleted: true }; });

  // Bulk SMS
  route('POST', '/api/sms/estimate', ({ body }) => platform.estimate(body));
  route('POST', '/api/sms/send', ({ body }) => platform.createCampaign({ ...body, billing: 'wallet' }));
  route('GET', '/api/campaigns', () => platform.listCampaigns());
  route('GET', '/api/campaigns/:id', ({ params }) => platform.getCampaign(params.id));
  route('POST', '/api/campaigns/:id/cancel', ({ params }) => platform.cancelCampaign(params.id));
  route('GET', '/api/messages', ({ query }) => platform.listMessages({ status: query.status }));
  route('GET', '/api/inbound', () => platform.listInbound());
  route('GET', '/api/optouts', () => platform.store.all('optouts').slice().reverse());

  // Premium subscriptions
  route('GET', '/api/services', () => platform.listServices());
  route('POST', '/api/services', ({ body }) => platform.createService(body));
  route('GET', '/api/services/:id/subscribers', ({ params }) => platform.listSubscribers(params.id));
  route('POST', '/api/services/:id/subscribers', ({ params, body }) => platform.subscribe(params.id, body.phone, 'api'));
  route('POST', '/api/services/:id/broadcast', ({ params, body }) => platform.broadcast(params.id, body));

  // Airtime
  route('GET', '/api/airtime', () => platform.listAirtime());
  route('POST', '/api/airtime/send', ({ body }) => platform.sendAirtime(body));

  // USSD
  route('GET', '/api/ussd/apps', () => platform.listUssdApps());
  route('POST', '/api/ussd/apps', ({ body }) => platform.createUssdApp(body));
  route('PUT', '/api/ussd/apps/:id', ({ params, body }) => platform.updateUssdApp(params.id, body));
  route('GET', '/api/ussd/sessions', () => platform.listUssdSessions());

  async function handleApi(req, res, url) {
    const match = routes
      .map((r) => ({ r, m: r.regex.exec(url.pathname) }))
      .filter(({ m }) => m);
    if (!match.length) return send(res, 404, { error: 'Not found' });
    const found = match.find(({ r }) => r.method === req.method);
    if (!found) return send(res, 405, { error: 'Method not allowed' });
    const { r, m } = found;

    if (r.auth) {
      const header = req.headers.authorization || '';
      const key = req.headers['x-api-key'] || (header.startsWith('Bearer ') ? header.slice(7) : '');
      if (!key || !safeEqual(key, platform.account.apiKey)) {
        return send(res, 401, { error: 'Missing or invalid API key' });
      }
    }

    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const result = await r.handler({ params, body, query: Object.fromEntries(url.searchParams) });
    send(res, 200, result);
  }

  function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    else if (!path.extname(pathname)) pathname += '.html';
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) {
        return fs.readFile(path.join(PUBLIC_DIR, '404.html'), (e2, page) =>
          e2 ? send(res, 404, 'Not found') : send(res, 404, page.toString(), { 'Content-Type': MIME['.html'] }));
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return send(res, 204, '');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof ApiError) return send(res, err.status, { error: err.message, details: err.details });
      console.error(err);
      return send(res, 500, { error: 'Internal server error' });
    }
  };
}

module.exports = { createApp };
