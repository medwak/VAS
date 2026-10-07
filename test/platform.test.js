'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Store } = require('../server/store');
const { seed } = require('../server/seed');
const { Platform } = require('../server/platform');
const { MockProvider } = require('../server/providers');
const { createApp } = require('../server/app');
const { normalize, detectNetwork } = require('../server/services/phone');
const { analyze } = require('../server/services/encoding');

function makePlatform(opts = {}) {
  let clock = new Date('2026-10-07T09:00:00Z');
  const store = new Store(null, seed);
  const platform = new Platform(store, {
    provider: new MockProvider({ deliveryRate: opts.deliveryRate ?? 1, random: () => 0.5 }),
    now: () => clock,
    dlrDelayMs: 1000,
  });
  return { platform, store, tick: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

test('phone normalisation and network detection', () => {
  assert.equal(normalize('0712 345 678'), '+254712345678');
  assert.equal(normalize('712345678'), '+254712345678');
  assert.equal(normalize('254733456789'), '+254733456789');
  assert.equal(normalize('+254 770-123-456'), '+254770123456');
  assert.equal(normalize('12345'), null);
  assert.equal(normalize('07123abc78'), null);
  assert.equal(detectNetwork('+254712345678'), 'Safaricom');
  assert.equal(detectNetwork('+254733456789'), 'Airtel');
  assert.equal(detectNetwork('+254770123456'), 'Telkom');
});

test('SMS segmentation for GSM-7 and UCS-2', () => {
  assert.deepEqual(analyze('a'.repeat(160)).segments, 1);
  assert.deepEqual(analyze('a'.repeat(161)).segments, 2);
  assert.equal(analyze('€').length, 2); // extended char takes 2 septets
  const uni = analyze('Habari 😀');
  assert.equal(uni.encoding, 'UCS-2');
  assert.equal(analyze('😀'.repeat(36)).segments, 2); // 72 code units > 70
  assert.equal(analyze('').segments, 0);
});

test('bulk campaign charges wallet, de-duplicates and delivers', async () => {
  const { platform, tick } = makePlatform();
  const before = platform.balance().balance;
  const c = platform.createCampaign({
    message: 'Hello {name}', senderId: 'VAS_DEMO',
    recipients: ['0712345678', '+254712345678', 'nonsense', '0733000111'],
  });
  assert.equal(c.recipients, 2);
  assert.equal(c.duplicates, 1);
  assert.equal(c.invalid, 1);
  assert.equal(c.cost, 0.8 + 0.6);
  assert.equal(platform.balance().balance, before - 1.4);

  await platform.dispatch();
  assert.equal(platform.getCampaign(c.id).stats.sent, 2);
  tick(2000);
  await platform.dispatch();
  const done = platform.getCampaign(c.id);
  assert.equal(done.stats.delivered, 2);
  assert.equal(done.status, 'completed');
  assert.equal(done.messages.find((m) => m.to === '+254712345678').text, 'Hello Amina Wanjiku');
});

test('insufficient balance is rejected without side effects', () => {
  const { platform, store } = makePlatform();
  store.data.account.balance = 0.5;
  assert.throws(() => platform.createCampaign({ message: 'Hi', senderId: 'VAS_DEMO', recipients: ['0712345678'] }), /Insufficient balance/);
  assert.equal(store.all('campaigns').length, 0);
  assert.equal(store.all('messages').length, 0);
});

test('scheduled campaigns wait and can be cancelled with a refund', async () => {
  const { platform, tick } = makePlatform();
  const start = platform.balance().balance;
  const c = platform.createCampaign({
    message: 'Later', senderId: 'VAS_DEMO', groupIds: ['grp_staff'], scheduleAt: '2026-10-07T10:00:00Z',
  });
  assert.equal(c.status, 'scheduled');
  await platform.dispatch();
  assert.equal(platform.getCampaign(c.id).stats.scheduled, 2);
  platform.cancelCampaign(c.id);
  assert.equal(platform.balance().balance, start);

  const d = platform.createCampaign({ message: 'Later', senderId: 'VAS_DEMO', groupIds: ['grp_staff'], scheduleAt: '2026-10-07T10:00:00Z' });
  tick(3600 * 1000);
  await platform.dispatch();
  assert.equal(platform.getCampaign(d.id).stats.sent, 2);
});

test('keyword opt-in, STOP opt-out and opt-out filtering', async () => {
  const { platform } = makePlatform();
  platform.handleInbound({ from: '0711000222', to: '22384', text: 'news please' });
  assert.equal(platform.listServices().find((s) => s.id === 'svc_news').subscribers, 1);

  platform.handleInbound({ from: '0711000222', to: '22384', text: 'STOP' });
  assert.equal(platform.listServices().find((s) => s.id === 'svc_news').subscribers, 0);

  const est = platform.estimate({ message: 'Promo', recipients: ['0711000222', '0712345678'] });
  assert.equal(est.optedOut, 1);
  assert.equal(est.recipients, 1);
});

test('premium broadcast is not charged and earns revenue share', async () => {
  const { platform, tick } = makePlatform();
  platform.subscribe('svc_news', '0711000222');
  await platform.dispatch(); // welcome message
  const before = platform.balance().balance;
  platform.broadcast('svc_news', { message: 'Headlines: ...' });
  assert.equal(platform.balance().balance, before);
  await platform.dispatch();
  tick(2000);
  await platform.dispatch();
  assert.equal(platform.store.get('services', 'svc_news').revenue, 6);
});

test('airtime debits discounted amount and validates input', async () => {
  const { platform } = makePlatform();
  const before = platform.balance().balance;
  const res = await platform.sendAirtime({ recipients: [{ phone: '0712345678', amount: 100 }] });
  assert.equal(res.results[0].status, 'success');
  assert.equal(platform.balance().balance, before - 97);
  await assert.rejects(platform.sendAirtime({ recipients: [{ phone: '0712345678', amount: 5 }] }), /between 10/);
});

test('USSD menu navigation, back and subscribe action', () => {
  const { platform } = makePlatform();
  const base = { sessionId: 's1', serviceCode: '*384*123#', phoneNumber: '+254712345678' };
  assert.match(platform.handleUssd({ ...base, text: '' }), /^CON Welcome[\s\S]*1\. My account/);
  assert.match(platform.handleUssd({ ...base, text: '1' }), /0\. Back/);
  assert.match(platform.handleUssd({ ...base, text: '1*0' }), /^CON Welcome/);
  assert.equal(platform.handleUssd({ ...base, text: '1*2' }), 'END Your number is +254712345678.');
  assert.match(platform.handleUssd({ ...base, text: '9' }), /^END Invalid/);
  assert.match(platform.handleUssd({ ...base, sessionId: 's2', text: '2' }), /^END You are now subscribed/);
  assert.equal(platform.listSubscribers('svc_news').length, 1);
  assert.match(platform.handleUssd({ ...base, serviceCode: '*999#' }), /unavailable/);
});

test('HTTP API enforces API key and serves endpoints', async () => {
  const { platform } = makePlatform();
  const server = http.createServer(createApp(platform));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/stats`)).status, 401);
    const key = platform.account.apiKey;
    const stats = await (await fetch(`${base}/api/stats`, { headers: { 'X-API-Key': key } })).json();
    assert.equal(stats.currency, 'KES');

    const bad = await fetch(`${base}/api/sms/send`, {
      method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: '{"message":""}',
    });
    assert.equal(bad.status, 400);

    const ussd = await fetch(`${base}/api/ussd/callback`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'sessionId=x&serviceCode=*384*123%23&phoneNumber=0712345678&text=',
    });
    assert.match(await ussd.text(), /^CON/);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const traversal = await fetch(`${base}/%2e%2e/package.json`);
    assert.notEqual(traversal.status, 200);
  } finally {
    server.close();
  }
});
