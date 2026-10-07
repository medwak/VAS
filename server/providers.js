'use strict';

const crypto = require('node:crypto');

/**
 * Gateway providers. A provider must implement:
 *   sendSms({ to, from, message })        -> { ok, providerId, error? }
 *   sendAirtime({ to, amount, currency }) -> { ok, providerId, error? }
 * and may implement deliveryStatus(message) when it has no delivery-report
 * callback (polling providers such as the simulator).
 */

const FAILURE_REASONS = ['AbsentSubscriber', 'DeliveryFailure', 'UserInBlacklist', 'InsufficientCredit'];

/** Simulated operator gateway, used by default and in tests. */
class MockProvider {
  constructor({ deliveryRate = 0.94, random = Math.random } = {}) {
    this.name = 'simulator';
    this.deliveryRate = deliveryRate;
    this.random = random;
    this.pollsDelivery = true;
  }

  async sendSms() {
    return { ok: true, providerId: `sim_${crypto.randomBytes(5).toString('hex')}` };
  }

  async sendAirtime() {
    return { ok: true, providerId: `sim_${crypto.randomBytes(5).toString('hex')}` };
  }

  deliveryStatus() {
    if (this.random() < this.deliveryRate) return { status: 'delivered' };
    const reason = FAILURE_REASONS[Math.floor(this.random() * FAILURE_REASONS.length)];
    return { status: 'failed', reason };
  }
}

/**
 * Africa's Talking gateway. Delivery reports arrive on
 * POST /api/callbacks/dlr (configure that URL in the AT dashboard).
 */
class AfricasTalkingProvider {
  constructor({ username, apiKey, sandbox = false }) {
    this.name = 'africastalking';
    this.username = username;
    this.apiKey = apiKey;
    this.pollsDelivery = false;
    const host = sandbox ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    this.base = `https://${host}/version1`;
  }

  async _post(path, params) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        apiKey: this.apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ username: this.username, ...params }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Africa's Talking HTTP ${res.status}`);
    return body;
  }

  async sendSms({ to, from, message }) {
    try {
      const params = { to, message };
      if (from) params.from = from;
      const body = await this._post('/messaging', params);
      const r = body?.SMSMessageData?.Recipients?.[0];
      if (r && (r.statusCode === 100 || r.statusCode === 101 || r.statusCode === 102)) {
        return { ok: true, providerId: r.messageId };
      }
      return { ok: false, error: r?.status || body?.SMSMessageData?.Message || 'Rejected' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async sendAirtime({ to, amount, currency }) {
    try {
      const body = await this._post('/airtime/send', {
        recipients: JSON.stringify([{ phoneNumber: to, amount: `${currency} ${amount}` }]),
      });
      const r = body?.responses?.[0];
      if (r && r.status === 'Sent') return { ok: true, providerId: r.requestId };
      return { ok: false, error: r?.errorMessage || body?.errorMessage || 'Rejected' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

function providerFromEnv(env = process.env) {
  if (env.VAS_PROVIDER === 'africastalking') {
    if (!env.AT_USERNAME || !env.AT_API_KEY) {
      throw new Error('VAS_PROVIDER=africastalking requires AT_USERNAME and AT_API_KEY');
    }
    return new AfricasTalkingProvider({
      username: env.AT_USERNAME,
      apiKey: env.AT_API_KEY,
      sandbox: env.AT_USERNAME === 'sandbox',
    });
  }
  return new MockProvider();
}

module.exports = { MockProvider, AfricasTalkingProvider, providerFromEnv };
