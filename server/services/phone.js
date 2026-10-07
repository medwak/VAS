'use strict';

// MSISDN helpers. Defaults target Kenya (+254) but the country code is configurable.

const DEFAULT_CC = process.env.VAS_COUNTRY_CODE || '254';

// Mobile prefixes (the 3 digits after the country code) per operator.
const NETWORK_PREFIXES = {
  Safaricom: [
    ...range(700, 729), 740, 741, 742, 743, 745, 746, 748, 757, 758, 759, 768, 769,
    ...range(790, 799), 110, 111, 112, 113, 114, 115,
  ],
  Airtel: [...range(730, 739), ...range(750, 756), 762, ...range(780, 789), 100, 101, 102],
  Telkom: [...range(770, 779)],
};

const PREFIX_TO_NETWORK = new Map();
for (const [network, prefixes] of Object.entries(NETWORK_PREFIXES)) {
  for (const p of prefixes) PREFIX_TO_NETWORK.set(String(p), network);
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/**
 * Normalise a phone number to E.164 (e.g. "0712 345 678" -> "+254712345678").
 * Returns null when the input cannot be a valid mobile number.
 */
function normalize(input, cc = DEFAULT_CC) {
  if (input === undefined || input === null) return null;
  let digits = String(input).trim().replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;

  if (digits.startsWith(cc)) {
    // already international
  } else if (digits.startsWith('0') && digits.length === 10) {
    digits = cc + digits.slice(1);
  } else if (digits.length === 9) {
    digits = cc + digits;
  } else {
    return null;
  }
  if (digits.length !== cc.length + 9) return null;
  return '+' + digits;
}

/** Detect the mobile operator of an E.164 number. */
function detectNetwork(e164, cc = DEFAULT_CC) {
  if (!e164) return 'Unknown';
  const local = e164.replace(/^\+/, '').slice(cc.length);
  return PREFIX_TO_NETWORK.get(local.slice(0, 3)) || 'Unknown';
}

module.exports = { normalize, detectNetwork, NETWORK_PREFIXES, DEFAULT_CC };
