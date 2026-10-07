# VASlink — Telecom Value Added Services platform

A self-hostable VAS platform built on top of mobile-network messaging. It has one prepaid wallet, one REST API and a dashboard for:

| Service | What it does |
| --- | --- |
| **Bulk SMS** | Personalised campaigns (`{name}`, `{first_name}`, `{phone}`), sender IDs, GSM-7/UCS-2 segment counting, per-network pricing, scheduling with cancel and refund, and delivery reports |
| **Two-way SMS** | Inbound messages on shortcodes, keyword routing, and automatic `STOP` opt-out that is enforced on every bulk send |
| **Premium subscriptions** | Keyword or USSD opt-in, broadcasts billed to subscribers, and revenue-share tracking |
| **USSD** | Menu-tree apps with back (`0`) and home (`00`) navigation, a subscribe action, session logs, and a feature-phone simulator in the dashboard |
| **Airtime** | Bulk top-ups at a discount, with automatic refunds when a top-up fails |
| **Wallet & analytics** | Ledger, M-Pesa/card/bank top-ups, delivery rates, traffic by network and a 7-day chart |

It has **no dependencies**: it needs only Node.js 18 or later.

## Run it

```bash
npm start            # http://localhost:3000
npm test             # node:test suite
```

- `/`: marketing site
- `/app`: dashboard. Click **Use the demo account**, or paste the API key printed in the console
- `/docs`: API reference

Data is stored in `data/db.json`. Delete that file to reset to the seed data.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `VAS_DATA_FILE` | `data/db.json` | Storage location |
| `VAS_API_KEY` | random | API key for a fresh install |
| `VAS_COUNTRY_CODE` | `254` | Country code used to normalise local numbers |
| `VAS_PROVIDER` | simulator | Set to `africastalking` to use a real gateway |
| `AT_USERNAME`, `AT_API_KEY` | | Africa's Talking credentials (`sandbox` username uses the sandbox) |
| `NODE_ENV=production` | | Disables the `/api/demo-key` endpoint |

With a real gateway, configure these callback URLs in the provider's dashboard:
`/api/sms/inbound`, `/api/callbacks/dlr` and `/api/ussd/callback`.

## Layout

```
server/
  index.js        HTTP server and 1s delivery engine tick
  app.js          router, auth, static files
  platform.js     business logic (SMS, subscriptions, USSD, airtime, wallet, stats)
  providers.js    gateway adapters: simulator, Africa's Talking
  store.js        JSON file store
  seed.js         demo account and sample services
  services/       phone normalisation, SMS encoding
public/           landing page, dashboard SPA, docs (vanilla HTML/CSS/JS)
test/             node:test suite
```
