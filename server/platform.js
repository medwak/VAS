'use strict';

const { normalize, detectNetwork } = require('./services/phone');
const { analyze } = require('./services/encoding');

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const money = (n) => Math.round(n * 100) / 100;
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const MAX_RECIPIENTS = 50000;
const MAX_MESSAGE_LENGTH = 1530; // 10 GSM segments

function personalize(template, contact) {
  return template
    .replace(/\{name\}/gi, contact.name || '')
    .replace(/\{first_name\}/gi, (contact.name || '').split(' ')[0])
    .replace(/\{phone\}/gi, contact.phone);
}

function required(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new ApiError(400, `${field} is required`);
  }
  return value;
}

/**
 * Business logic for the VAS platform, independent of HTTP.
 * Products: bulk SMS, two-way/premium SMS subscriptions, airtime, USSD, wallet.
 */
class Platform {
  constructor(store, { provider, now = () => new Date(), dlrDelayMs = 1500 } = {}) {
    this.store = store;
    this.provider = provider;
    this.now = now;
    this.dlrDelayMs = dlrDelayMs;
    this._dispatching = false;
  }

  get account() {
    return this.store.data.account;
  }

  get pricing() {
    return this.store.data.pricing;
  }

  // ---------------------------------------------------------------- wallet

  balance() {
    return { balance: money(this.account.balance), currency: this.account.currency };
  }

  _post(type, amount, description, ref) {
    amount = money(amount);
    if (type === 'debit') {
      if (amount > this.account.balance + 1e-9) {
        throw new ApiError(402, `Insufficient balance: need ${this.account.currency} ${amount.toFixed(2)}, have ${this.account.balance.toFixed(2)}`);
      }
      this.account.balance = money(this.account.balance - amount);
    } else {
      this.account.balance = money(this.account.balance + amount);
    }
    return this.store.insert('transactions', {
      type, amount, balanceAfter: this.account.balance, description, ref,
    }, 'txn');
  }

  topUp({ amount, method = 'mpesa', phone }) {
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount < 10 || amount > 1000000) {
      throw new ApiError(400, 'amount must be between 10 and 1,000,000');
    }
    if (!['mpesa', 'card', 'bank'].includes(method)) throw new ApiError(400, 'method must be mpesa, card or bank');
    let payer;
    if (method === 'mpesa') {
      payer = normalize(phone);
      if (!payer) throw new ApiError(400, 'A valid M-Pesa phone number is required');
    }
    const ref = `${method.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    return this._post('credit', amount, `Wallet top-up via ${method}${payer ? ` (${payer})` : ''}`, ref);
  }

  transactions(limit = 100) {
    return this.store.all('transactions').slice(-limit).reverse();
  }

  // ------------------------------------------------------- sender IDs

  requestSenderId({ name }) {
    name = String(required(name, 'name')).trim().toUpperCase();
    if (!/^[A-Z0-9_\- ]{3,11}$/.test(name)) {
      throw new ApiError(400, 'Sender ID must be 3-11 letters, digits, spaces, _ or -');
    }
    if (this.store.find('senderIds', (s) => s.name === name).length) {
      throw new ApiError(409, 'Sender ID already exists');
    }
    return this.store.insert('senderIds', { name, status: 'pending' }, 'sid');
  }

  // ------------------------------------------------- contacts & groups

  createGroup({ name, description = '' }) {
    name = String(required(name, 'name')).trim();
    return this.store.insert('groups', { name, description }, 'grp');
  }

  deleteGroup(id) {
    if (!this.store.remove('groups', id)) throw new ApiError(404, 'Group not found');
    for (const c of this.store.all('contacts')) c.groupIds = c.groupIds.filter((g) => g !== id);
    this.store.save();
  }

  listGroups() {
    const contacts = this.store.all('contacts');
    return this.store.all('groups').map((g) => ({
      ...g, size: contacts.filter((c) => c.groupIds.includes(g.id)).length,
    }));
  }

  /** Create or update contacts; existing phone numbers are merged. */
  importContacts({ contacts, groupId }) {
    if (!Array.isArray(contacts) || contacts.length === 0) throw new ApiError(400, 'contacts must be a non-empty array');
    if (groupId && !this.store.get('groups', groupId)) throw new ApiError(404, 'Group not found');
    const result = { created: 0, updated: 0, invalid: [] };
    const byPhone = new Map(this.store.all('contacts').map((c) => [c.phone, c]));
    for (const raw of contacts) {
      const phone = normalize(raw.phone);
      if (!phone) {
        result.invalid.push(raw.phone);
        continue;
      }
      const existing = byPhone.get(phone);
      if (existing) {
        if (raw.name) existing.name = String(raw.name).trim();
        if (groupId && !existing.groupIds.includes(groupId)) existing.groupIds.push(groupId);
        result.updated++;
      } else {
        const c = this.store.insert('contacts', {
          name: String(raw.name || '').trim(), phone, groupIds: groupId ? [groupId] : [],
        }, 'con');
        byPhone.set(phone, c);
        result.created++;
      }
    }
    this.store.save();
    return result;
  }

  listContacts({ groupId, q } = {}) {
    const query = (q || '').toLowerCase();
    return this.store.all('contacts')
      .filter((c) => !groupId || c.groupIds.includes(groupId))
      .filter((c) => !query || c.name.toLowerCase().includes(query) || c.phone.includes(query))
      .map((c) => ({ ...c, network: detectNetwork(c.phone), optedOut: this._isOptedOut(c.phone) }));
  }

  deleteContact(id) {
    if (!this.store.remove('contacts', id)) throw new ApiError(404, 'Contact not found');
  }

  _isOptedOut(phone) {
    return this.store.all('optouts').some((o) => o.phone === phone);
  }

  // ------------------------------------------------------------ bulk SMS

  /** Expand raw numbers + groups into a de-duplicated audience. */
  resolveAudience({ recipients = [], groupIds = [], respectOptOut = true }) {
    if (typeof recipients === 'string') recipients = recipients.split(/[\s,;]+/);
    const contactsByPhone = new Map(this.store.all('contacts').map((c) => [c.phone, c]));
    const seen = new Set();
    const audience = [];
    const invalid = [];
    let duplicates = 0;
    let optedOut = 0;

    const add = (phone, name) => {
      if (seen.has(phone)) {
        duplicates++;
        return;
      }
      seen.add(phone);
      if (respectOptOut && this._isOptedOut(phone)) {
        optedOut++;
        return;
      }
      audience.push({ phone, name: name ?? contactsByPhone.get(phone)?.name ?? '', network: detectNetwork(phone) });
    };

    for (const raw of recipients) {
      if (raw === '' || raw === undefined || raw === null) continue;
      const phone = normalize(raw);
      if (phone) add(phone);
      else invalid.push(String(raw));
    }
    for (const gid of groupIds) {
      if (!this.store.get('groups', gid)) throw new ApiError(404, `Group ${gid} not found`);
      for (const c of this.store.all('contacts')) if (c.groupIds.includes(gid)) add(c.phone, c.name);
    }
    return { audience, invalid, duplicates, optedOut };
  }

  _price(network) {
    return this.pricing.sms[network] ?? this.pricing.sms.Unknown;
  }

  /** Price a send without creating anything. */
  estimate({ message, recipients, groupIds }) {
    const { audience, invalid, duplicates, optedOut } = this.resolveAudience({ recipients, groupIds });
    const info = analyze(message || '');
    const byNetwork = {};
    let cost = 0;
    let totalSegments = 0;
    for (const r of audience) {
      const segs = analyze(personalize(message || '', r)).segments || 1;
      const c = segs * this._price(r.network);
      cost += c;
      totalSegments += segs;
      byNetwork[r.network] = byNetwork[r.network] || { recipients: 0, cost: 0 };
      byNetwork[r.network].recipients++;
      byNetwork[r.network].cost = money(byNetwork[r.network].cost + c);
    }
    return {
      ...info,
      recipients: audience.length,
      totalSegments,
      invalid,
      duplicates,
      optedOut,
      byNetwork,
      cost: money(cost),
      currency: this.account.currency,
      balance: money(this.account.balance),
    };
  }

  createCampaign({ name, message, senderId, recipients, groupIds = [], scheduleAt, billing = 'wallet', serviceId }) {
    message = String(required(message, 'message'));
    if (message.length > MAX_MESSAGE_LENGTH) throw new ApiError(400, `message exceeds ${MAX_MESSAGE_LENGTH} characters`);

    if (billing === 'wallet') {
      senderId = String(required(senderId, 'senderId')).toUpperCase();
      const sid = this.store.find('senderIds', (s) => s.name === senderId)[0];
      if (!sid) throw new ApiError(400, `Unknown sender ID ${senderId}`);
      if (sid.status !== 'approved') throw new ApiError(400, `Sender ID ${senderId} is not approved yet`);
    }

    let when = null;
    if (scheduleAt) {
      when = new Date(scheduleAt);
      if (Number.isNaN(when.getTime())) throw new ApiError(400, 'scheduleAt must be an ISO date');
      if (when <= this.now()) when = null; // past dates send immediately
    }

    const { audience, invalid, duplicates, optedOut } = this.resolveAudience({
      recipients, groupIds, respectOptOut: billing === 'wallet',
    });
    if (audience.length === 0) throw new ApiError(400, 'No valid recipients', { invalid, optedOut });
    if (audience.length > MAX_RECIPIENTS) throw new ApiError(400, `Maximum ${MAX_RECIPIENTS} recipients per campaign`);

    const rows = audience.map((r) => {
      const text = personalize(message, r);
      const { segments, encoding } = analyze(text);
      const cost = billing === 'wallet' ? money(segments * this._price(r.network)) : 0;
      return { to: r.phone, network: r.network, text, segments, encoding, cost };
    });
    const totalCost = money(rows.reduce((s, r) => s + r.cost, 0));

    const campaign = this.store.insert('campaigns', {
      name: (name && String(name).trim()) || `Campaign ${new Date(this.now()).toLocaleString('en-GB')}`,
      message, senderId, groupIds, billing, serviceId: serviceId || null,
      status: when ? 'scheduled' : 'queued',
      scheduleAt: when ? when.toISOString() : null,
      recipients: rows.length, invalid: invalid.length, duplicates, optedOut,
      cost: totalCost,
    }, 'cmp');

    if (totalCost > 0) {
      try {
        this._post('debit', totalCost, `Bulk SMS: ${campaign.name} (${rows.length} recipients)`, campaign.id);
      } catch (err) {
        this.store.remove('campaigns', campaign.id);
        throw err;
      }
    }

    for (const r of rows) {
      this.store.all('messages').push({
        id: `msg_${campaign.id.slice(4)}_${this.store.all('messages').length.toString(36)}`,
        campaignId: campaign.id, from: senderId, ...r,
        status: when ? 'scheduled' : 'queued',
        createdAt: new Date(this.now()).toISOString(),
      });
    }
    this.store.save();
    return this.campaignSummary(campaign);
  }

  cancelCampaign(id) {
    const campaign = this.store.get('campaigns', id);
    if (!campaign) throw new ApiError(404, 'Campaign not found');
    if (campaign.status !== 'scheduled') throw new ApiError(409, 'Only scheduled campaigns can be cancelled');
    const msgs = this.store.find('messages', (m) => m.campaignId === id);
    msgs.forEach((m) => { m.status = 'cancelled'; });
    campaign.status = 'cancelled';
    if (campaign.cost > 0) this._post('credit', campaign.cost, `Refund: cancelled ${campaign.name}`, id);
    this.store.save();
    return this.campaignSummary(campaign);
  }

  campaignSummary(campaign) {
    const counts = { scheduled: 0, queued: 0, sent: 0, delivered: 0, failed: 0, cancelled: 0 };
    for (const m of this.store.all('messages')) if (m.campaignId === campaign.id) counts[m.status]++;
    return { ...campaign, stats: counts };
  }

  listCampaigns() {
    return this.store.all('campaigns').slice().reverse().map((c) => this.campaignSummary(c));
  }

  getCampaign(id) {
    const c = this.store.get('campaigns', id);
    if (!c) throw new ApiError(404, 'Campaign not found');
    return { ...this.campaignSummary(c), messages: this.store.find('messages', (m) => m.campaignId === id).slice(0, 500) };
  }

  listMessages({ status, limit = 200 } = {}) {
    return this.store.all('messages').filter((m) => !status || m.status === status).slice(-limit).reverse();
  }

  /**
   * One pass of the delivery engine: release due scheduled campaigns, submit
   * queued messages to the gateway and collect delivery reports.
   */
  async dispatch({ batchSize = 500 } = {}) {
    if (this._dispatching) return;
    this._dispatching = true;
    try {
      const now = this.now();
      for (const c of this.store.all('campaigns')) {
        if (c.status === 'scheduled' && new Date(c.scheduleAt) <= now) {
          c.status = 'queued';
          for (const m of this.store.all('messages')) if (m.campaignId === c.id && m.status === 'scheduled') m.status = 'queued';
        }
      }

      const queued = this.store.all('messages').filter((m) => m.status === 'queued').slice(0, batchSize);
      for (const m of queued) {
        const res = await this.provider.sendSms({ to: m.to, from: m.from, message: m.text });
        m.sentAt = new Date(this.now()).toISOString();
        if (res.ok) {
          m.status = 'sent';
          m.providerId = res.providerId;
        } else {
          m.status = 'failed';
          m.reason = res.error;
        }
      }

      if (this.provider.pollsDelivery) {
        const cutoff = this.now().getTime() - this.dlrDelayMs;
        for (const m of this.store.all('messages')) {
          if (m.status === 'sent' && new Date(m.sentAt).getTime() <= cutoff) {
            const dlr = this.provider.deliveryStatus(m);
            this._applyDlr(m, dlr.status, dlr.reason);
          }
        }
      }

      for (const c of this.store.all('campaigns')) {
        if (c.status === 'queued' || c.status === 'sending') {
          const s = this.campaignSummary(c).stats;
          if (s.queued === 0 && s.sent === 0) c.status = 'completed';
          else if (s.queued < c.recipients) c.status = 'sending';
        }
      }
      this.store.save();
    } finally {
      this._dispatching = false;
    }
  }

  _applyDlr(message, status, reason) {
    message.status = status;
    message.deliveredAt = new Date(this.now()).toISOString();
    if (reason) message.reason = reason;
    if (status === 'delivered') {
      const campaign = this.store.get('campaigns', message.campaignId);
      if (campaign?.billing === 'premium' && campaign.serviceId) {
        const svc = this.store.get('services', campaign.serviceId);
        if (svc) svc.revenue = money(svc.revenue + svc.price * this.pricing.premiumRevenueShare);
      }
    }
  }

  /** Delivery report pushed by an HTTP gateway (Africa's Talking format). */
  deliveryReport({ id, status, failureReason }) {
    const m = this.store.all('messages').find((x) => x.providerId === id);
    if (!m) throw new ApiError(404, 'Unknown message id');
    const ok = String(status).toLowerCase() === 'success';
    const pending = ['sent', 'submitted', 'buffered'].includes(String(status).toLowerCase());
    if (!pending) this._applyDlr(m, ok ? 'delivered' : 'failed', ok ? undefined : failureReason || status);
    this.store.save();
    return m;
  }

  // ----------------------------------------- inbound SMS & subscriptions

  createService({ name, keyword, shortcode, price, description = '', welcome = '' }) {
    name = String(required(name, 'name')).trim();
    keyword = String(required(keyword, 'keyword')).trim().toUpperCase();
    shortcode = String(required(shortcode, 'shortcode')).trim();
    price = Number(price);
    if (!/^[A-Z0-9]{2,20}$/.test(keyword)) throw new ApiError(400, 'keyword must be 2-20 letters or digits');
    if (STOP_WORDS.has(keyword)) throw new ApiError(400, 'keyword is reserved');
    if (!/^\d{3,6}$/.test(shortcode)) throw new ApiError(400, 'shortcode must be 3-6 digits');
    if (!Number.isFinite(price) || price < 0) throw new ApiError(400, 'price must be a positive number');
    if (this.store.find('services', (s) => s.keyword === keyword && s.shortcode === shortcode).length) {
      throw new ApiError(409, `Keyword ${keyword} is already in use on ${shortcode}`);
    }
    return this.store.insert('services', {
      name, keyword, shortcode, price, description,
      welcome: welcome || `You are now subscribed to ${name}. Reply STOP to ${shortcode} to cancel.`,
      status: 'active', revenue: 0,
    }, 'svc');
  }

  listServices() {
    const subs = this.store.all('subscribers');
    return this.store.all('services').map((s) => ({
      ...s, subscribers: subs.filter((x) => x.serviceId === s.id && x.status === 'active').length,
    }));
  }

  listSubscribers(serviceId) {
    return this.store.find('subscribers', (s) => !serviceId || s.serviceId === serviceId).slice().reverse();
  }

  subscribe(serviceId, phone, channel = 'sms') {
    const svc = this.store.get('services', serviceId);
    if (!svc) throw new ApiError(404, 'Service not found');
    const msisdn = normalize(phone);
    if (!msisdn) throw new ApiError(400, 'Invalid phone number');
    let sub = this.store.find('subscribers', (s) => s.serviceId === serviceId && s.phone === msisdn)[0];
    const isNew = !sub || sub.status !== 'active';
    if (sub) Object.assign(sub, { status: 'active', channel, subscribedAt: new Date(this.now()).toISOString() });
    else sub = this.store.insert('subscribers', { serviceId, phone: msisdn, channel, status: 'active', subscribedAt: new Date(this.now()).toISOString() }, 'sub');
    // Opting in to a service clears any previous global opt-out.
    const optouts = this.store.all('optouts');
    const i = optouts.findIndex((o) => o.phone === msisdn);
    if (i !== -1) optouts.splice(i, 1);
    if (isNew) this._systemSms(msisdn, svc.shortcode, svc.welcome);
    this.store.save();
    return sub;
  }

  _systemSms(to, from, text) {
    const c = this.store.insert('campaigns', {
      name: `System reply to ${to}`, message: text, senderId: from, billing: 'system', status: 'queued',
      recipients: 1, invalid: 0, duplicates: 0, optedOut: 0, cost: 0, system: true,
    }, 'cmp');
    const { segments, encoding } = analyze(text);
    this.store.all('messages').push({
      id: `msg_${c.id.slice(4)}_0`, campaignId: c.id, from, to, network: detectNetwork(to),
      text, segments, encoding, cost: 0, status: 'queued', createdAt: new Date(this.now()).toISOString(),
    });
  }

  /** Handle an MO (mobile-originated) message: keyword opt-ins and STOP. */
  handleInbound({ from, to, text }) {
    const phone = normalize(required(from, 'from'));
    if (!phone) throw new ApiError(400, 'Invalid sender number');
    const body = String(text || '').trim();
    const keyword = body.split(/\s+/)[0].toUpperCase();
    const record = this.store.insert('inbound', { from: phone, to: to || null, text: body, keyword, action: 'none' }, 'mo');

    if (STOP_WORDS.has(keyword)) {
      const subs = this.store.find('subscribers', (s) => {
        const svc = this.store.get('services', s.serviceId);
        return s.phone === phone && s.status === 'active' && (!to || svc?.shortcode === to);
      });
      subs.forEach((s) => { s.status = 'inactive'; s.unsubscribedAt = new Date(this.now()).toISOString(); });
      if (!this._isOptedOut(phone)) this.store.insert('optouts', { phone, source: to || 'sms' }, 'opt');
      record.action = subs.length ? `unsubscribed:${subs.length}` : 'opted-out';
      if (to) this._systemSms(phone, to, 'You have been unsubscribed and will no longer receive messages. Thank you.');
    } else {
      const svc = this.store.find('services', (s) => s.keyword === keyword && s.status === 'active' && (!to || s.shortcode === to))[0];
      if (svc) {
        this.subscribe(svc.id, phone, 'sms');
        record.action = `subscribed:${svc.id}`;
      }
    }
    this.store.save();
    return record;
  }

  listInbound(limit = 200) {
    return this.store.all('inbound').slice(-limit).reverse();
  }

  /** Send content to all active subscribers of a premium service. */
  broadcast(serviceId, { message }) {
    const svc = this.store.get('services', serviceId);
    if (!svc) throw new ApiError(404, 'Service not found');
    const phones = this.store.find('subscribers', (s) => s.serviceId === serviceId && s.status === 'active').map((s) => s.phone);
    if (!phones.length) throw new ApiError(400, 'This service has no active subscribers');
    return this.createCampaign({
      name: `${svc.name} broadcast`, message, senderId: svc.shortcode, recipients: phones,
      billing: 'premium', serviceId,
    });
  }

  // -------------------------------------------------------------- airtime

  async sendAirtime({ recipients }) {
    if (!Array.isArray(recipients) || !recipients.length) throw new ApiError(400, 'recipients must be a non-empty array');
    if (recipients.length > 1000) throw new ApiError(400, 'Maximum 1000 recipients per request');
    const rows = recipients.map((r) => {
      const phone = normalize(r.phone);
      const amount = Number(r.amount);
      if (!phone) throw new ApiError(400, `Invalid phone number: ${r.phone}`);
      if (!Number.isInteger(amount) || amount < 10 || amount > 10000) {
        throw new ApiError(400, `Amount for ${phone} must be a whole number between 10 and 10,000`);
      }
      return { phone, amount, network: detectNetwork(phone) };
    });
    const discount = this.pricing.airtimeDiscount;
    const total = money(rows.reduce((s, r) => s + r.amount * (1 - discount), 0));
    const txn = this._post('debit', total, `Airtime to ${rows.length} recipient(s)`, 'AIRTIME');

    const results = [];
    let refund = 0;
    for (const r of rows) {
      const res = await this.provider.sendAirtime({ to: r.phone, amount: r.amount, currency: this.account.currency });
      const cost = money(r.amount * (1 - discount));
      if (!res.ok) refund += cost;
      results.push(this.store.insert('airtime', {
        ...r, currency: this.account.currency, cost, status: res.ok ? 'success' : 'failed',
        providerId: res.providerId || null, reason: res.error || null, txnId: txn.id,
      }, 'air'));
    }
    if (refund > 0) this._post('credit', refund, 'Refund: failed airtime', txn.id);
    return { total: money(total - refund), discount, results };
  }

  listAirtime(limit = 200) {
    return this.store.all('airtime').slice(-limit).reverse();
  }

  // ---------------------------------------------------------------- USSD

  createUssdApp({ name, serviceCode, menu }) {
    name = String(required(name, 'name')).trim();
    serviceCode = String(required(serviceCode, 'serviceCode')).trim();
    if (!/^\*\d+(\*\d+)*#$/.test(serviceCode)) throw new ApiError(400, 'serviceCode must look like *384*123#');
    if (this.store.find('ussdApps', (a) => a.serviceCode === serviceCode).length) throw new ApiError(409, 'Service code already in use');
    validateMenu(menu);
    return this.store.insert('ussdApps', { name, serviceCode, menu, status: 'active' }, 'ussd');
  }

  updateUssdApp(id, { name, menu, status }) {
    const app = this.store.get('ussdApps', id);
    if (!app) throw new ApiError(404, 'USSD app not found');
    const patch = {};
    if (name) patch.name = String(name).trim();
    if (menu) { validateMenu(menu); patch.menu = menu; }
    if (status) patch.status = status === 'active' ? 'active' : 'paused';
    return this.store.update('ussdApps', id, patch);
  }

  listUssdApps() {
    const sessions = this.store.all('ussdSessions');
    return this.store.all('ussdApps').map((a) => ({ ...a, sessions: sessions.filter((s) => s.appId === a.id).length }));
  }

  listUssdSessions(limit = 100) {
    return this.store.all('ussdSessions').slice(-limit).reverse();
  }

  /**
   * USSD gateway callback (Africa's Talking style): `text` holds every input
   * of the session joined by "*". Returns "CON ..." to continue or "END ...".
   */
  handleUssd({ sessionId, serviceCode, phoneNumber, text = '' }) {
    const phone = normalize(phoneNumber) || String(phoneNumber || '');
    const app = this.store.find('ussdApps', (a) => a.serviceCode === serviceCode)[0];
    if (!app || app.status !== 'active') return 'END This service is currently unavailable.';

    // Walk the menu following the inputs; "0" goes back, "00" to main menu.
    const stack = [app.menu];
    const inputs = String(text).split('*').filter((x) => x !== '');
    for (const input of inputs) {
      const node = stack[stack.length - 1];
      const option = (node.options || []).find((o) => o.key === input);
      if (option) stack.push(option.next);
      else if (input === '00') stack.length = 1;
      else if (input === '0' && stack.length > 1) stack.pop();
      else return this._logUssd(app, sessionId, phone, text, 'END Invalid choice. Please dial again.');
    }

    const node = stack[stack.length - 1];
    const body = String(node.text || '').replace(/\{phone\}/g, phone);
    let response;
    if (node.options && node.options.length) {
      const lines = node.options.map((o) => `${o.key}. ${o.label}`);
      if (stack.length > 1) lines.push('0. Back');
      response = `CON ${body}\n${lines.join('\n')}`;
    } else {
      if (node.action?.type === 'subscribe') {
        try {
          this.subscribe(node.action.serviceId, phone, 'ussd');
        } catch {
          return this._logUssd(app, sessionId, phone, text, 'END Sorry, we could not complete your request.');
        }
      }
      response = `END ${body}`;
    }
    return this._logUssd(app, sessionId, phone, text, response);
  }

  _logUssd(app, sessionId, phone, text, response) {
    const id = sessionId || `anon_${Date.now()}`;
    let s = this.store.all('ussdSessions').find((x) => x.sessionId === id);
    if (!s) s = this.store.insert('ussdSessions', { sessionId: id, appId: app.id, serviceCode: app.serviceCode, phone, hops: 0 }, 'ses');
    s.hops++;
    s.lastInput = text;
    s.status = response.startsWith('END') ? 'ended' : 'active';
    s.updatedAt = new Date(this.now()).toISOString();
    this.store.save();
    return response;
  }

  // ------------------------------------------------------------ analytics

  stats() {
    const messages = this.store.all('messages').filter((m) => m.status !== 'cancelled');
    const count = (st) => messages.filter((m) => m.status === st).length;
    const delivered = count('delivered');
    const failed = count('failed');
    const finished = delivered + failed;

    const days = [];
    const today = new Date(this.now());
    today.setHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      days.push({ date: d.toISOString().slice(0, 10), start: d.getTime(), end: d.getTime() + 86400000, sent: 0, delivered: 0, failed: 0 });
    }
    for (const m of messages) {
      const t = new Date(m.createdAt).getTime();
      const day = days.find((d) => t >= d.start && t < d.end);
      if (!day) continue;
      day.sent++;
      if (m.status === 'delivered') day.delivered++;
      if (m.status === 'failed') day.failed++;
    }

    const byNetwork = {};
    for (const m of messages) byNetwork[m.network] = (byNetwork[m.network] || 0) + 1;

    const spend = this.store.all('transactions').filter((t) => t.type === 'debit').reduce((s, t) => s + t.amount, 0);
    const refunds = this.store.all('transactions').filter((t) => t.type === 'credit' && String(t.description).startsWith('Refund')).reduce((s, t) => s + t.amount, 0);

    return {
      balance: money(this.account.balance),
      currency: this.account.currency,
      sms: {
        total: messages.length,
        delivered,
        failed,
        pending: messages.length - finished,
        deliveryRate: finished ? Math.round((delivered / finished) * 1000) / 10 : 0,
      },
      spend: money(spend - refunds),
      campaigns: this.store.find('campaigns', (c) => !c.system).length,
      contacts: this.store.all('contacts').length,
      airtime: money(this.store.find('airtime', (a) => a.status === 'success').reduce((s, a) => s + a.amount, 0)),
      ussdSessions: this.store.all('ussdSessions').length,
      subscribers: this.store.find('subscribers', (s) => s.status === 'active').length,
      premiumRevenue: money(this.store.all('services').reduce((s, x) => s + (x.revenue || 0), 0)),
      daily: days.map(({ start, end, ...d }) => d),
      byNetwork,
      recentCampaigns: this.listCampaigns().filter((c) => !c.system).slice(0, 5),
    };
  }
}

function validateMenu(menu, depth = 0) {
  if (!menu || typeof menu !== 'object') throw new ApiError(400, 'menu must be an object');
  if (depth > 8) throw new ApiError(400, 'menu is nested too deeply (max 8 levels)');
  if (typeof menu.text !== 'string' || !menu.text.trim()) throw new ApiError(400, 'every menu node needs text');
  if (menu.options !== undefined) {
    if (!Array.isArray(menu.options)) throw new ApiError(400, 'options must be an array');
    const keys = new Set();
    for (const o of menu.options) {
      if (!o || !/^\d{1,2}$/.test(String(o.key)) || o.key === '0' || o.key === '00') {
        throw new ApiError(400, 'option keys must be 1-99 (0 and 00 are reserved for navigation)');
      }
      if (keys.has(o.key)) throw new ApiError(400, `duplicate option key ${o.key}`);
      keys.add(o.key);
      if (!o.label) throw new ApiError(400, 'every option needs a label');
      validateMenu(o.next, depth + 1);
    }
  }
}

module.exports = { Platform, ApiError, personalize };
