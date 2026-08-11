# Schmidt's Marketing Hot Sheet (Unified Dashboard)

One app that replaces both `schmidtdash-main` (Ecwid dashboard) and
`schmidtpromo-main` (GHL promotions proxy), and adds Google Analytics and an
AI social-media planner. The server keeps every API token secret — the
browser only ever talks to this app.

## Tabs

1. **Overview** — KPI grid (sessions, orders, conversion rate, AOV, revenue,
   active promotions, abandoned cart value, users), Website Highlights, and a
   **Current Promotions** quick summary (this replaced the old
   "What Needs Attention" card).
2. **Promotions** (second in the menu) — live promo cards from Smart 1 Suite
   (GoHighLevel opportunities in the *Schmidt Marketing Projects* pipeline,
   *Upcoming Events* stage) plus a 30-day Promotion Pipeline.
3. **Ecommerce** — Ecwid orders, revenue, abandoned carts, order status, top
   products, 12-month revenue chart, discount usage.
4. **Digital Marketing** — GA4 sessions/users/page views, top pages, traffic
   sources; email + paid ad tables are placeholders for future sources.
5. **Campaign Calendar** — live promos this week + next-60-day schedule built
   from upcoming promos and holiday opportunities.
6. **Social Media** — AI-suggested upcoming social-media/food holidays with
   promo tie-ins for schmidthaus.com (restaurant, catering, food trucks) and
   ready-to-copy post text. "Get Fresh Ideas" regenerates.
7. **Review** — the old "What Needs Attention" content, now its own tab:
   cart abandonment, promos ending soon, missing promo codes, week-over-week
   declines, recently-ended promos to consider renewing.

## Quick start (preview with sample data)

```bash
npm install
MOCK_MODE=true npm start
# open http://localhost:10000
```

## Deploy to Render

1. Push this folder to a GitHub repo.
2. Render → New + → Web Service → pick the repo.
   Build: `npm install` • Start: `npm start` • Health check: `/health`
3. Add environment variables (see `.env.example`):

| Variable | What it is |
|---|---|
| `ECWID_STORE_ID` | Ecwid store id (default 111281497) |
| `ECWID_API_TOKEN` | Ecwid token with `read_orders`, `read_products` |
| `GHL_PIT` | GoHighLevel Private Integration Token (`pit-…`) with `opportunities.readonly` + `locations/customFields.readonly` |
| `GHL_LOCATION_ID` | `EY0n2rtraCf6EEUKpaEE` |
| `GA4_PROPERTY_ID` | **GA4 property id** (numeric, from GA Admin → Property Settings). Note: this is *not* the account id 189270321. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Entire service-account key JSON on one line; add the service-account email as **Viewer** on the GA4 property |
| `OPENAI_API_KEY` | For the Social Media tab |
| `OPENAI_MODEL` | Optional, default `gpt-4o-mini` |
| `MOCK_MODE` | `true` = sample data (demo), `false` = live |

## API endpoints

| Endpoint | Purpose |
|---|---|
| `/api/all` | Everything the dashboard needs in one call |
| `/api/ecwid` | Ecwid metrics |
| `/api/promotions` | GHL promotions (active/upcoming/ended, classified server-side) |
| `/api/analytics` | GA4 week-over-week sessions/users/views + top pages/channels |
| `/api/social` | AI holiday suggestions (`?refresh=1` forces regeneration; otherwise cached 12h) |
| `/api/review` | Needs-attention items for the Review tab |
| `/api/pipelines`, `/api/custom-fields` | GHL diagnostics (carried over from the old proxy) |
| `/health` | Health check |

## Security note (important)

The old `schmidtpromo-main/promo.html` contains a **hard-coded GHL token**
(`pit-e475c122-…`) in client-side code. If that page was ever published,
**rotate that token in GoHighLevel** and use only this server-side app going
forward — the new app never exposes tokens to the browser.

## Notes

- API responses are cached (default 300s, `CACHE_SECONDS`) so Render's free
  tier and the Ecwid/GHL rate limits stay comfortable; the page auto-refreshes
  every 5 minutes.
- Conversion rate is computed as Ecwid orders ÷ GA4 sessions, which needs
  both integrations live.
