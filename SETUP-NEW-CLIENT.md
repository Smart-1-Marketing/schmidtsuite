# Standing this dashboard up for another client

Nothing about a particular business is written into the code — the business
lives in environment variables. To serve a new customer: fork the repo (or
point a second Render service at it), set the values below, deploy.

## 1. The business itself

These feed every AI prompt — the social planner, the post images it generates,
and the cart-recovery drafts. Get these right and the AI writes like that
business instead of like a German restaurant.

| Variable | What to put |
|---|---|
| `BRAND_NAME` | Trading name, as customers say it |
| `SITE_URL` | Domain, no protocol (`example.com`) |
| `BRAND_DESCRIPTION` | **One line: what the business is and what it sells.** The one that matters most — everything else is tone. e.g. *"a lakeside winery in Thornville, Ohio with a tasting room, live music and a wine club"* |
| `BRAND_SHORT` | Three or four words for tight spots |
| `BRAND_IMAGE_STYLE` | How generated photos should look |
| `BRAND_RULES` | Any rule the AI must always follow for the industry — alcohol, medical, financial advice. Blank if none apply |

## 2. Everything else

Per-customer as usual: `ECWID_*`, `GHL_PIT` / `GHL_LOCATION_ID`, the pipeline
names, the promotion form URL, `GA4_PROPERTY_ID` plus the Google OAuth trio,
`OPENAI_API_KEY`, and `ADMIN_PASSWORD` to switch the Ecom Tools menu on.

See `.env.example` for the full list with comments.

## 3. What still needs a code edit

Two things are per-industry and not yet settings — worth knowing before you
quote a timeline:

- **Business lines.** The social planner asks for `restaurant | catering |
  foodtrucks`, and the dashboard maps those to labels. A different industry
  needs both lists changed (`SOCIAL_SYSTEM_PROMPT` area in `server.js`, and
  `lineLabel` in `public/index.html`).
- **GA4 key pages.** `KEY_PAGE_GROUPS` in `server.js` matches URL paths like
  `/catering` and `/truck` to name the sections on the Digital Marketing tab.

## Quick check after deploying

The startup log says what resolved and what didn't:

```
Ecwid:      configured (store 111281497)
Ecom tools: password protected     (or: OFF — set ADMIN_PASSWORD to enable them)
Brand:      Schmidt's Sausage Haus — a German restaurant in Columbus
```

Anything reading `NOT configured` or `OFF` is a setting still to fill in.

## Before you deploy

There is no build step, so a typo reaches production as a crashed service.
Two commands catch nearly everything:

```bash
node --check server.js          # syntax
MOCK_MODE=true PORT=10999 node server.js   # boots, and the banner shows the wiring
```
