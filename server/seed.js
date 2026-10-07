'use strict';

const crypto = require('node:crypto');

/** Initial dataset for a fresh install: one demo account plus sample services. */
function seed() {
  const now = new Date().toISOString();
  const apiKey = process.env.VAS_API_KEY || `vas_${crypto.randomBytes(16).toString('hex')}`;

  const groups = [
    { id: 'grp_customers', name: 'Customers', description: 'Active retail customers', createdAt: now },
    { id: 'grp_staff', name: 'Staff', description: 'Internal team', createdAt: now },
  ];

  const contacts = [
    ['Amina Wanjiku', '+254712345678', ['grp_customers']],
    ['Brian Otieno', '+254733456789', ['grp_customers']],
    ['Cynthia Achieng', '+254722111222', ['grp_customers', 'grp_staff']],
    ['David Kiprop', '+254770123456', ['grp_staff']],
    ['Esther Mutua', '+254799876543', ['grp_customers']],
  ].map(([name, phone, groupIds], i) => ({
    id: `con_seed${i}`, name, phone, groupIds, createdAt: now,
  }));

  return {
    account: {
      name: 'Demo Telecom Ltd',
      apiKey,
      currency: 'KES',
      balance: 5000,
      createdAt: now,
    },
    pricing: {
      sms: { Safaricom: 0.8, Airtel: 0.6, Telkom: 0.6, Unknown: 1.0 },
      airtimeDiscount: 0.03,
      premiumRevenueShare: 0.6,
    },
    senderIds: [
      { id: 'sid_vasdemo', name: 'VAS_DEMO', status: 'approved', createdAt: now },
      { id: 'sid_alerts', name: 'ALERTS', status: 'approved', createdAt: now },
    ],
    groups,
    contacts,
    campaigns: [],
    messages: [],
    transactions: [
      { id: 'txn_seed', type: 'credit', amount: 5000, balanceAfter: 5000, description: 'Welcome credit', ref: 'SEED', createdAt: now },
    ],
    airtime: [],
    ussdApps: [
      {
        id: 'ussd_demo',
        name: 'Customer Self-care',
        serviceCode: '*384*123#',
        status: 'active',
        createdAt: now,
        menu: {
          text: 'Welcome to VAS Demo',
          options: [
            {
              key: '1', label: 'My account',
              next: {
                text: 'My account',
                options: [
                  { key: '1', label: 'Check balance', next: { text: 'Your loyalty balance is 1,250 points.' } },
                  { key: '2', label: 'My number', next: { text: 'Your number is {phone}.' } },
                ],
              },
            },
            {
              key: '2', label: 'Daily news alerts',
              next: { text: 'You are now subscribed to daily news. Reply STOP to 22384 to cancel.', action: { type: 'subscribe', serviceId: 'svc_news' } },
            },
            { key: '3', label: 'Talk to us', next: { text: 'Call 0800 123 456 (toll free) or email help@vas.example.' } },
          ],
        },
      },
    ],
    ussdSessions: [],
    services: [
      {
        id: 'svc_news', name: 'Daily News', keyword: 'NEWS', shortcode: '22384', price: 10,
        description: 'Top headlines every morning.', welcome: 'Welcome to Daily News! You will get top headlines every morning. Reply STOP to cancel.',
        status: 'active', revenue: 0, createdAt: now,
      },
      {
        id: 'svc_tips', name: 'Farming Tips', keyword: 'SHAMBA', shortcode: '22384', price: 5,
        description: 'Weekly agronomy tips for smallholder farmers.', welcome: 'Karibu! You are subscribed to weekly farming tips. Reply STOP to cancel.',
        status: 'active', revenue: 0, createdAt: now,
      },
    ],
    subscribers: [],
    inbound: [],
    optouts: [],
  };
}

module.exports = { seed };
