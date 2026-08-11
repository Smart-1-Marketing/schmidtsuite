/**
 * Schmidt's Marketing Hot Sheet — Unified Server
 * ----------------------------------------------------------------------
 * One Express app that merges:
 *   1. Ecwid ecommerce dashboard   (was: schmidtdash-main)
 *   2. GoHighLevel promotions proxy (was: schmidtpromo-main)
 *   3. Google Analytics 4 (GA4 Data API via service account)
 *   4. AI social-media holiday planner (OpenAI)
 *
 * All secrets live ONLY here as environment variables — nothing sensitive
 * ever reaches the browser.
 *
 * Environment variables (see .env.example):
 *   ECWID_STORE_ID        Ecwid store id            (default 111281497)
 *   ECWID_API_TOKEN       Ecwid secret token        (required for live data)
 *   GHL_PIT               GoHighLevel Private Integration Token (pit-...)
 *   GHL_LOCATION_ID       Sub-account id            (default EY0n2rtraCf6EEUKpaEE)
 *   PROMO_PIPELINE_NAME   default "Schmidt Marketing Projects"
 *   PROMO_STAGE_NAME      default "Upcoming Events"
 *   PROMO_PIPELINE_ID / PROMO_STAGE_ID   optional explicit ids (win over names)
 *   GA4_PROPERTY_ID       GA4 property id (numeric — NOT the account id)
 *   GOOGLE_SERVICE_ACCOUNT_JSON   full service-account key JSON (one line)
 *   OPENAI_API_KEY        OpenAI key for the Social Media tab
 *   OPENAI_MODEL          default "gpt-4o-mini"
 *   ALLOWED_ORIGIN        CORS origin (default "*")
 *   CACHE_SECONDS         API cache TTL (default 300)
 *   MOCK_MODE             "true" -> serve realistic sample data (no keys needed)
 *   PORT                  default 10000
 */

import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const {
  ECWID_STORE_ID = "111281497",
  ECWID_API_TOKEN,
  GHL_PIT,
  GHL_LOCATION_ID = "EY0n2rtraCf6EEUKpaEE",
  PROMO_PIPELINE_ID = "",
  PROMO_PIPELINE_NAME = "Schmidt Marketing Projects",
  PROMO_STAGE_ID = "",
  PROMO_STAGE_NAME = "Upcoming Events",
  GA4_PROPERTY_ID = "",
  GOOGLE_SERVICE_ACCOUNT_JSON = "",
  GOOGLE_OAUTH_REFRESH_TOKEN = "",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  ALLOWED_ORIGIN = "*",
  CACHE_SECONDS = "300",
  MOCK_MODE = "false",
  PORT = 10000,
} = process.env;

// OAuth client id/secret: accept either the GOOGLE_OAUTH_* names or the
// plain GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET names (e.g. from an existing
// Render environment group).
const GOOGLE_OAUTH_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "";

const MOCK = String(MOCK_MODE).toLowerCase() === "true";
const CACHE_MS = Math.max(30, parseInt(CACHE_SECONDS, 10) || 300) * 1000;

// ---------------------------------------------------------------- CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------- helpers
const simpleCache = new Map(); // key -> { at, data }
function cached(key) {
  const hit = simpleCache.get(key);
  return hit && Date.now() - hit.at < CACHE_MS ? hit.data : null;
}
function remember(key, data) {
  simpleCache.set(key, { at: Date.now(), data });
  return data;
}

function getDateRange(period = "week") {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let startDate;
  if (period === "week") {
    startDate = new Date(startOfToday);
    startDate.setDate(startDate.getDate() - startOfToday.getDay());
  } else if (period === "month") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === "year") {
    startDate = new Date(now.getFullYear(), 0, 1);
  } else if (period === "lastWeek") {
    startDate = new Date(startOfToday);
    startDate.setDate(startDate.getDate() - startOfToday.getDay() - 7);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);
    return { startDate, endDate };
  } else if (period === "lastMonth") {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { startDate, endDate: new Date(now.getFullYear(), now.getMonth(), 1) };
  }
  return { startDate, endDate: new Date() };
}

const pct = (cur, prev) =>
  prev > 0 ? Number((((cur - prev) / prev) * 100).toFixed(1)) : null;

// ================================================================ ECWID
const ECWID_BASE = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}`;
let productCache = {};

async function ecwidGet(endpoint, params = {}) {
  const url = new URL(`${ECWID_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${ECWID_API_TOKEN}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    console.error(`Ecwid API ${resp.status} on ${endpoint}`);
    return null;
  }
  return resp.json();
}

async function ecwidPageAll(endpoint) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < 60; page++) {
    const data = await ecwidGet(endpoint, { limit: 100, offset });
    if (!data || !data.items || data.items.length === 0) break;
    items.push(...data.items);
    if (data.items.length < 100) break;
    offset += 100;
  }
  return items;
}

async function buildProductCache() {
  const products = await ecwidPageAll("/products");
  productCache = {};
  products.forEach((p) => (productCache[p.id] = p.name));
}

function topProducts(orders, since) {
  const sales = {};
  orders.forEach((order) => {
    if (new Date(order.createDate) < since || !order.items) return;
    order.items.forEach((item) => {
      const s = (sales[item.productId] ||= {
        productId: item.productId,
        name: productCache[item.productId] || item.name || "Unknown",
        quantity: 0,
        revenue: 0,
      });
      s.quantity += item.quantity;
      s.revenue += item.price * item.quantity;
    });
  });
  return Object.values(sales).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
}

function orderStatusCounts(orders) {
  const counts = { pending: 0, processing: 0, shipped: 0, delivered: 0, other: 0 };
  orders.forEach((o) => {
    const s = (o.status || "other").toLowerCase();
    if (counts[s] !== undefined) counts[s]++;
    else counts.other++;
  });
  return counts;
}

function discountMetrics(orders, startDate, endDate = new Date()) {
  const inRange = orders.filter((o) => {
    const d = new Date(o.createDate);
    return d >= startDate && d < endDate;
  });
  const withDiscount = inRange.filter(
    (o) => (o.couponDiscount || 0) + (o.discount || 0) > 0
  );
  const totalDiscountAmount = inRange.reduce(
    (sum, o) => sum + (o.couponDiscount || 0) + (o.discount || 0), 0);
  return {
    totalOrders: inRange.length,
    ordersWithDiscounts: withDiscount.length,
    totalDiscountAmount,
    discountPercentage: inRange.length
      ? Number(((withDiscount.length / inRange.length) * 100).toFixed(1))
      : 0,
  };
}

async function getEcwidData() {
  if (MOCK) return mockEcwid();
  if (!ECWID_API_TOKEN) return { error: "ECWID_API_TOKEN not configured" };
  const hit = cached("ecwid");
  if (hit) return hit;

  if (!Object.keys(productCache).length) await buildProductCache();
  const orders = await ecwidPageAll("/orders");

  const { startDate: weekStart } = getDateRange("week");
  const { startDate: monthStart } = getDateRange("month");
  const { startDate: yearStart } = getDateRange("year");
  const { startDate: lastWeekStart, endDate: lastWeekEnd } = getDateRange("lastWeek");
  const { startDate: lastMonthStart, endDate: lastMonthEnd } = getDateRange("lastMonth");

  const between = (a, b) =>
    orders.filter((o) => {
      const d = new Date(o.createDate);
      return d >= a && (!b || d < b);
    });

  const thisWeek = between(weekStart);
  const lastWeek = between(lastWeekStart, lastWeekEnd);
  const thisMonth = between(monthStart);
  const lastMonth = between(lastMonthStart, lastMonthEnd);
  const revenue = (arr) => arr.reduce((s, o) => s + (o.total || 0), 0);

  // 12-month sales
  const monthlySales = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const monthOrders = between(start, end);
    monthlySales.push({
      month: start.toLocaleString("en-US", { month: "short", year: "2-digit" }),
      revenue: revenue(monthOrders),
      orders: monthOrders.length,
    });
  }

  // abandoned carts
  let abandonedWeek = { count: 0, value: 0 };
  let abandonedMonth = { count: 0, value: 0 };
  const carts = await ecwidGet("/abandoned_sales", { limit: 100, offset: 0 });
  if (carts?.items) {
    const wk = carts.items.filter((c) => new Date(c.createDate) >= weekStart);
    const mo = carts.items.filter((c) => new Date(c.createDate) >= monthStart);
    abandonedWeek = { count: wk.length, value: wk.reduce((s, c) => s + (c.cartValue || 0), 0) };
    abandonedMonth = { count: mo.length, value: mo.reduce((s, c) => s + (c.cartValue || 0), 0) };
  }

  return remember("ecwid", {
    thisWeek: {
      totalOrders: thisWeek.length,
      totalRevenue: revenue(thisWeek),
      abandonedCarts: abandonedWeek.count,
      abandonedCartValue: abandonedWeek.value,
      orderStatus: orderStatusCounts(thisWeek),
    },
    lastWeek: { totalOrders: lastWeek.length, totalRevenue: revenue(lastWeek) },
    thisMonth: {
      totalOrders: thisMonth.length,
      totalRevenue: revenue(thisMonth),
      abandonedCarts: abandonedMonth.count,
      abandonedCartValue: abandonedMonth.value,
      orderStatus: orderStatusCounts(thisMonth),
    },
    lastMonth: { totalOrders: lastMonth.length, totalRevenue: revenue(lastMonth) },
    discountMetrics: {
      week: discountMetrics(orders, weekStart),
      month: discountMetrics(orders, monthStart),
      year: discountMetrics(orders, yearStart),
    },
    topProductsWeek: topProducts(orders, weekStart),
    topProductsMonth: topProducts(orders, monthStart),
    topProductsYear: topProducts(orders, yearStart),
    monthlySales,
    lastUpdated: new Date().toISOString(),
  });
}

// ================================================================ GHL PROMOTIONS
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const FIELD_MAP = {
  promo_name: "name",
  this_promo_is_for: "audience",
  promo_start_date: "start",
  promo_end_date: "end",
  description_of_promo: "details",
  promo_code_or_neccessary_item: "promoCode",
  promo_upload: "upload",
};
const PROMO_DATA_KEYS = Object.keys(FIELD_MAP).filter((k) => k !== "promo_upload");

let fieldIdByKey = null;
let promoScope = null;

async function ghlGet(pathName) {
  const resp = await fetch(`${GHL_BASE}${pathName}`, {
    headers: { Authorization: `Bearer ${GHL_PIT}`, Version: GHL_VERSION, Accept: "application/json" },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err = new Error(`GHL API ${resp.status}: ${body.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

const shortKey = (fk) => String(fk || "").split(".").pop().toLowerCase();

async function resolveFieldIds() {
  if (fieldIdByKey) return fieldIdByKey;
  const data = await ghlGet(
    `/locations/${encodeURIComponent(GHL_LOCATION_ID)}/customFields?model=opportunity`
  );
  fieldIdByKey = {};
  for (const f of data.customFields || []) fieldIdByKey[shortKey(f.fieldKey)] = f.id;
  return fieldIdByKey;
}

function valueById(opp, id) {
  if (!id || !Array.isArray(opp.customFields)) return "";
  const m = opp.customFields.find((f) => f.id === id || f.customFieldId === id);
  if (!m) return "";
  const v = m.fieldValue ?? m.value ?? m.field_value ?? m.fieldValueString ??
    m.fieldValueArray ?? m.selectedOptions ?? "";
  return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

function parsePromoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let d = null;
  if (/^\d{13}$/.test(s)) d = new Date(Number(s));
  else if (/^\d{10}$/.test(s)) d = new Date(Number(s) * 1000);
  else d = new Date(s);
  return d && !isNaN(d.getTime()) ? d : null;
}

function formatDateValue(v) {
  const d = parsePromoDate(v);
  return d
    ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : String(v || "").trim();
}

async function resolvePromoScope() {
  if (promoScope) return promoScope;
  const data = await ghlGet(
    `/opportunities/pipelines?locationId=${encodeURIComponent(GHL_LOCATION_ID)}`
  );
  const pipelines = data.pipelines || [];
  let pipeline = null;
  if (PROMO_PIPELINE_ID) {
    pipeline = pipelines.find((p) => p.id === PROMO_PIPELINE_ID) || { id: PROMO_PIPELINE_ID, stages: [] };
  } else {
    const needle = PROMO_PIPELINE_NAME.toLowerCase();
    pipeline = pipelines.find((p) => (p.name || "").toLowerCase().includes(needle)) || null;
  }
  let stageId = "";
  if (pipeline) {
    if (PROMO_STAGE_ID) stageId = PROMO_STAGE_ID;
    else if (PROMO_STAGE_NAME) {
      const sNeedle = PROMO_STAGE_NAME.toLowerCase();
      const stage = (pipeline.stages || []).find((s) => (s.name || "").toLowerCase().includes(sNeedle));
      stageId = stage ? stage.id : "";
    }
  }
  promoScope = { pipelineId: pipeline ? pipeline.id : "", stageId };
  return promoScope;
}

async function enrichIfNeeded(opp) {
  if (Array.isArray(opp.customFields) && opp.customFields.length) return opp;
  try {
    const data = await ghlGet(`/opportunities/${encodeURIComponent(opp.id)}`);
    const full = data.opportunity || data;
    if (Array.isArray(full.customFields)) opp.customFields = full.customFields;
  } catch { /* keep as-is */ }
  return opp;
}

function classifyPromo(startRaw, endRaw) {
  const now = new Date();
  const start = parsePromoDate(startRaw);
  const end = parsePromoDate(endRaw);
  let status = "upcoming";
  if (start && end) {
    if (start <= now && end >= now) status = "active";
    else if (end < now) status = "ended";
    else status = "upcoming";
  } else if (start) {
    status = start <= now ? "active" : "upcoming";
  } else if (end) {
    status = end >= now ? "active" : "ended";
  }
  let daysLeft = null;
  if (end) daysLeft = Math.ceil((end - now) / 86400000);
  return { status, daysLeft, startDate: start, endDate: end };
}

async function getPromotions() {
  if (MOCK) return mockPromotions();
  if (!GHL_PIT) return { error: "GHL_PIT not configured", promotions: [] };
  const hit = cached("promos");
  if (hit) return hit;

  const idMap = await resolveFieldIds();
  const scope = await resolvePromoScope();
  let path2 = `/opportunities/search?location_id=${encodeURIComponent(GHL_LOCATION_ID)}&limit=100`;
  if (scope.pipelineId) path2 += `&pipeline_id=${encodeURIComponent(scope.pipelineId)}`;
  const data = await ghlGet(path2);
  const opps = (data.opportunities || []).filter((o) => {
    if (scope.pipelineId) {
      if (o.pipelineId !== scope.pipelineId) return false;
      if (scope.stageId && o.pipelineStageId !== scope.stageId) return false;
      return true;
    }
    return !!valueById(o, idMap.promo_name);
  });
  const enriched = await Promise.all(opps.map(enrichIfNeeded));

  const promotions = enriched
    .filter((o) => PROMO_DATA_KEYS.some((k) => valueById(o, idMap[k])))
    .map((o) => {
      const out = { id: o.id };
      for (const [key, name] of Object.entries(FIELD_MAP)) out[name] = valueById(o, idMap[key]);
      if (!out.name) out.name = o.name || "";
      const cls = classifyPromo(out.start, out.end);
      out.status = cls.status;
      out.daysLeft = cls.daysLeft;
      out.startISO = cls.startDate ? cls.startDate.toISOString() : null;
      out.endISO = cls.endDate ? cls.endDate.toISOString() : null;
      out.start = formatDateValue(out.start);
      out.end = formatDateValue(out.end);
      const c = o.contact || {};
      out.contact = c.email || c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || "";
      return out;
    })
    .sort((a, b) => (a.startISO || "") < (b.startISO || "") ? -1 : 1);

  return remember("promos", { promotions, lastUpdated: new Date().toISOString() });
}

// ================================================================ GA4
// Two auth modes, in priority order:
//   1. OAuth refresh token (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN)
//      — reads GA as YOUR Google account; works with plain Viewer access,
//        no GA admin needed. Get a refresh token via /auth/google.
//   2. Service account (GOOGLE_SERVICE_ACCOUNT_JSON)
//      — needs a GA admin to add the service-account email as Viewer.
let gaToken = { token: null, exp: 0 };

const OAUTH_CONFIGURED =
  GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REFRESH_TOKEN;
const GA_CONFIGURED = OAUTH_CONFIGURED || !!GOOGLE_SERVICE_ACCOUNT_JSON;

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

async function ga4AccessToken() {
  if (gaToken.token && Date.now() < gaToken.exp - 60000) return gaToken.token;

  // ---- Mode 1: OAuth refresh token (no GA admin required) ----
  if (OAUTH_CONFIGURED) {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN,
      }),
    });
    if (!resp.ok) throw new Error(`Google OAuth refresh failed: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    gaToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
    return gaToken.token;
  }

  // ---- Mode 2: Service account JWT ----
  const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key).toString("base64url");
  const jwt = `${header}.${claims}.${signature}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`Google token exchange failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  gaToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return gaToken.token;
}

async function ga4RunReport(body) {
  const token = await ga4AccessToken();
  const resp = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!resp.ok) throw new Error(`GA4 API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

const iso = (d) => d.toISOString().slice(0, 10);

async function getAnalytics() {
  if (MOCK) return mockAnalytics();
  if (!GA4_PROPERTY_ID || !GA_CONFIGURED) {
    return { error: "GA4 not configured: set GA4_PROPERTY_ID plus either the GOOGLE_OAUTH_* trio (visit /auth/google to get a refresh token) or GOOGLE_SERVICE_ACCOUNT_JSON" };
  }
  const hit = cached("ga4");
  if (hit) return hit;

  const { startDate: weekStart } = getDateRange("week");
  const { startDate: lastWeekStart, endDate: lastWeekEnd } = getDateRange("lastWeek");
  const today = new Date();
  const lastWeekEndInclusive = new Date(lastWeekEnd - 86400000);

  const [totals, pages, channels, keyPagesReport] = await Promise.all([
    ga4RunReport({
      dateRanges: [
        { startDate: iso(weekStart), endDate: iso(today), name: "thisWeek" },
        { startDate: iso(lastWeekStart), endDate: iso(lastWeekEndInclusive), name: "lastWeek" },
      ],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }],
    }),
    ga4RunReport({
      dateRanges: [{ startDate: iso(weekStart), endDate: iso(today) }],
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 5,
    }),
    ga4RunReport({
      dateRanges: [{ startDate: iso(weekStart), endDate: iso(today) }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 5,
    }),
    // Key pages (home / catering / food truck), this week vs last week
    ga4RunReport({
      dateRanges: [
        { startDate: iso(weekStart), endDate: iso(today), name: "thisWeek" },
        { startDate: iso(lastWeekStart), endDate: iso(lastWeekEndInclusive), name: "lastWeek" },
      ],
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      limit: 500,
    }),
  ]);

  // Group page rows into the three key pages of schmidthaus.com
  const KEY_PAGE_GROUPS = [
    { label: "Home", match: (p) => p === "/" || p === "/home" || p.startsWith("/?") },
    { label: "Catering", match: (p) => p.includes("catering") },
    { label: "Food Truck", match: (p) => p.includes("truck") },
  ];
  const keyPages = KEY_PAGE_GROUPS.map((g) => ({
    label: g.label,
    thisWeek: { views: 0, users: 0 },
    lastWeek: { views: 0, users: 0 },
  }));
  for (const row of keyPagesReport.rows || []) {
    const pagePath = (row.dimensionValues?.[0]?.value || "").toLowerCase();
    const range = row.dimensionValues?.[1]?.value || "thisWeek";
    const bucket = range === "lastWeek" || range === "date_range_1" ? "lastWeek" : "thisWeek";
    const views = Number(row.metricValues?.[0]?.value || 0);
    const users = Number(row.metricValues?.[1]?.value || 0);
    for (let i = 0; i < KEY_PAGE_GROUPS.length; i++) {
      if (KEY_PAGE_GROUPS[i].match(pagePath)) {
        keyPages[i][bucket].views += views;
        keyPages[i][bucket].users += users;
        break;
      }
    }
  }
  keyPages.forEach((k) => {
    k.viewsChangePercent = pct(k.thisWeek.views, k.lastWeek.views);
  });

  const byRange = {};
  for (const row of totals.rows || []) {
    const range = row.dimensionValues?.[0]?.value || "thisWeek";
    byRange[range] = {
      sessions: Number(row.metricValues?.[0]?.value || 0),
      users: Number(row.metricValues?.[1]?.value || 0),
      pageViews: Number(row.metricValues?.[2]?.value || 0),
    };
  }
  // When two date ranges are used GA4 adds a dateRange dimension automatically
  const thisWeek = byRange["thisWeek"] || byRange["date_range_0"] || { sessions: 0, users: 0, pageViews: 0 };
  const lastWeek = byRange["lastWeek"] || byRange["date_range_1"] || { sessions: 0, users: 0, pageViews: 0 };

  return remember("ga4", {
    thisWeek,
    lastWeek,
    sessionsChangePercent: pct(thisWeek.sessions, lastWeek.sessions),
    topPages: (pages.rows || []).map((r) => ({
      page: r.dimensionValues[0].value,
      views: Number(r.metricValues[0].value),
    })),
    topChannels: (channels.rows || []).map((r) => ({
      channel: r.dimensionValues[0].value,
      sessions: Number(r.metricValues[0].value),
    })),
    keyPages,
    lastUpdated: new Date().toISOString(),
  });
}

// ---------------- One-time OAuth consent helper ----------------
// Visit /auth/google once (locally or on Render) to authorize with the
// Google account that already has Viewer access on the GA4 property.
// The callback page shows the refresh token to paste into
// GOOGLE_OAUTH_REFRESH_TOKEN. Requires GOOGLE_OAUTH_CLIENT_ID + SECRET,
// and the redirect URI below added to the OAuth client in Google Cloud.
function oauthRedirectUri(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${req.get("host")}/auth/google/callback`;
}

app.get("/auth/google", (req, res) => {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    return res.status(500).send(
      "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first (Google Cloud → APIs & Services → Credentials → OAuth client ID, type: Web application), and add this redirect URI to it: " +
      oauthRedirectUri(req)
    );
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", oauthRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "https://www.googleapis.com/auth/analytics.readonly");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  res.redirect(url.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code — start at /auth/google");
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: oauthRedirectUri(req),
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.refresh_token) {
      return res.status(500).send(
        "Token exchange failed or no refresh_token returned. Response: " +
        JSON.stringify(data).slice(0, 500) +
        " — try again from /auth/google (the 'prompt=consent' step is what forces a refresh token)."
      );
    }
    res.send(`
      <div style="font-family:Arial;max-width:700px;margin:40px auto;line-height:1.6;">
        <h2 style="color:#9f1d20;">Google Analytics connected ✔</h2>
        <p>Copy this value into the <code>GOOGLE_OAUTH_REFRESH_TOKEN</code> environment
        variable (Render → your service → Environment), then redeploy:</p>
        <textarea style="width:100%;height:80px;font-family:monospace;" readonly>${data.refresh_token}</textarea>
        <p style="color:#747474;font-size:13px;">Keep it secret — it grants read access to
        your Google Analytics. This page is the only time it is shown; it is not stored anywhere.</p>
      </div>`);
  } catch (err) {
    res.status(500).send("OAuth error: " + err.message);
  }
});

// ================================================================ SOCIAL (OpenAI)
const SOCIAL_CACHE_MS = 12 * 60 * 60 * 1000; // refresh twice a day
let socialCache = { at: 0, data: null };

const SOCIAL_SYSTEM_PROMPT = `You are the marketing planner for Schmidt's Sausage Haus (schmidthaus.com), a beloved family-owned German restaurant in Columbus, Ohio's historic German Village, with three business lines: the restaurant (famous for Bahama Mamas and cream puffs), catering, and food trucks. Respond ONLY with valid JSON.`;

function socialUserPrompt() {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return `Today is ${today}. List the 8 best upcoming social-media/food holidays and observances over the next 60 days that Schmidt's Sausage Haus could tie promotions to (e.g., National Bratwurst Day, Oktoberfest, National Dessert Day, Labor Day, National Food Truck Day). For each, give a realistic date, and concrete tie-in ideas. Return JSON in exactly this shape:
{"suggestions":[{"holiday":"","date":"YYYY-MM-DD","why":"one sentence on why it fits Schmidt's","businessLines":["restaurant"|"catering"|"foodtrucks"],"promoIdea":"one-sentence promotion tied to schmidthaus.com","samplePost":"a ready-to-use social post under 250 characters including a call to action to schmidthaus.com"}]}
Order by date ascending. Only include dates in the next 60 days.`;
}

async function getSocialSuggestions(force = false) {
  if (MOCK) return mockSocial();
  if (!OPENAI_API_KEY) return { error: "OPENAI_API_KEY not configured", suggestions: [] };
  if (!force && socialCache.data && Date.now() - socialCache.at < SOCIAL_CACHE_MS) {
    return { ...socialCache.data, cached: true };
  }
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SOCIAL_SYSTEM_PROMPT },
        { role: "user", content: socialUserPrompt() },
      ],
      temperature: 0.7,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenAI API ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  let parsed = { suggestions: [] };
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch {
    throw new Error("OpenAI returned unparseable JSON");
  }
  const out = {
    suggestions: parsed.suggestions || [],
    model: OPENAI_MODEL,
    generatedAt: new Date().toISOString(),
  };
  socialCache = { at: Date.now(), data: out };
  return out;
}

// ================================================================ REVIEW
function buildReview({ ecwid, promos, analytics }) {
  const items = [];
  const money = (n) => `$${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  if (ecwid && !ecwid.error) {
    if (ecwid.thisWeek.abandonedCartValue > 0) {
      items.push({
        severity: "review",
        title: "Cart Abandonment",
        detail: `${ecwid.thisWeek.abandonedCarts} abandoned carts this week worth ${money(ecwid.thisWeek.abandonedCartValue)}. Consider a recovery email or promo code.`,
      });
    }
    const revChange = pct(ecwid.thisWeek.totalRevenue, ecwid.lastWeek.totalRevenue);
    if (revChange !== null && revChange <= -20) {
      items.push({
        severity: "review",
        title: "Revenue Down vs Last Week",
        detail: `Ecommerce revenue is ${revChange}% vs last week (${money(ecwid.thisWeek.totalRevenue)} vs ${money(ecwid.lastWeek.totalRevenue)}).`,
      });
    }
    const orderChange = pct(ecwid.thisWeek.totalOrders, ecwid.lastWeek.totalOrders);
    if (orderChange !== null && orderChange <= -20) {
      items.push({
        severity: "watch",
        title: "Orders Down vs Last Week",
        detail: `Orders are ${orderChange}% week over week (${ecwid.thisWeek.totalOrders} vs ${ecwid.lastWeek.totalOrders}).`,
      });
    }
    if (ecwid.thisWeek.orderStatus?.pending > 0) {
      items.push({
        severity: "watch",
        title: "Pending Orders",
        detail: `${ecwid.thisWeek.orderStatus.pending} order(s) still pending this week — confirm fulfillment is on track.`,
      });
    }
  }

  if (promos && !promos.error) {
    for (const p of promos.promotions || []) {
      if (p.status === "active" && p.daysLeft !== null && p.daysLeft >= 0 && p.daysLeft <= 7) {
        items.push({
          severity: "action",
          title: `Promotion Ending Soon: ${p.name}`,
          detail: `Ends ${p.end} (${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left). Decide whether to extend, replace, or let it lapse.`,
        });
      }
      if (p.status === "upcoming" && !p.promoCode) {
        items.push({
          severity: "action",
          title: `Upcoming Promo Missing Code: ${p.name}`,
          detail: `Launches ${p.start || "TBD"} — confirm creative, promo code and launch date.`,
        });
      }
      if (p.status === "ended" && p.daysLeft !== null && p.daysLeft >= -14) {
        items.push({
          severity: "watch",
          title: `Recently Ended: ${p.name}`,
          detail: `Ended ${p.end}. Review results and decide on renewal.`,
        });
      }
    }
    const active = (promos.promotions || []).filter((p) => p.status === "active");
    if (active.length === 0) {
      items.push({
        severity: "watch",
        title: "No Active Promotions",
        detail: "Nothing is live right now — check the Social Media tab for upcoming holiday tie-in ideas.",
      });
    }
  }

  if (analytics && !analytics.error) {
    if (analytics.sessionsChangePercent !== null && analytics.sessionsChangePercent <= -20) {
      items.push({
        severity: "watch",
        title: "Website Traffic Down",
        detail: `Sessions are ${analytics.sessionsChangePercent}% vs last week (${analytics.thisWeek.sessions} vs ${analytics.lastWeek.sessions}).`,
      });
    }
  }

  const order = { review: 0, action: 1, watch: 2 };
  items.sort((a, b) => order[a.severity] - order[b.severity]);
  return { items, lastUpdated: new Date().toISOString() };
}

// ================================================================ MOCK DATA
function mockEcwid() {
  return {
    thisWeek: {
      totalOrders: 42, totalRevenue: 3860.5, abandonedCarts: 9, abandonedCartValue: 742.18,
      orderStatus: { pending: 3, processing: 6, shipped: 21, delivered: 12, other: 0 },
    },
    lastWeek: { totalOrders: 38, totalRevenue: 3421.75 },
    thisMonth: {
      totalOrders: 61, totalRevenue: 5612.4, abandonedCarts: 14, abandonedCartValue: 1105.6,
      orderStatus: { pending: 3, processing: 8, shipped: 30, delivered: 20, other: 0 },
    },
    lastMonth: { totalOrders: 149, totalRevenue: 13780.9 },
    discountMetrics: {
      week: { totalOrders: 42, ordersWithDiscounts: 11, totalDiscountAmount: 216.4, discountPercentage: 26.2 },
      month: { totalOrders: 61, ordersWithDiscounts: 15, totalDiscountAmount: 301.8, discountPercentage: 24.6 },
      year: { totalOrders: 1240, ordersWithDiscounts: 356, totalDiscountAmount: 6120.15, discountPercentage: 28.7 },
    },
    topProductsWeek: [
      { productId: 1, name: "Bahama Mama Sausages (4-pack)", quantity: 26, revenue: 624.0 },
      { productId: 2, name: "Jumbo Cream Puff Kit", quantity: 18, revenue: 522.0 },
      { productId: 3, name: "German Potato Salad (Family Size)", quantity: 15, revenue: 285.0 },
      { productId: 4, name: "Sauerkraut Balls (Frozen, 24ct)", quantity: 12, revenue: 216.0 },
      { productId: 5, name: "Schmidt's Signature Mustard", quantity: 11, revenue: 98.45 },
    ],
    topProductsMonth: [
      { productId: 1, name: "Bahama Mama Sausages (4-pack)", quantity: 41, revenue: 984.0 },
      { productId: 2, name: "Jumbo Cream Puff Kit", quantity: 27, revenue: 783.0 },
      { productId: 3, name: "German Potato Salad (Family Size)", quantity: 20, revenue: 380.0 },
    ],
    topProductsYear: [
      { productId: 1, name: "Bahama Mama Sausages (4-pack)", quantity: 512, revenue: 12288.0 },
      { productId: 2, name: "Jumbo Cream Puff Kit", quantity: 388, revenue: 11252.0 },
    ],
    monthlySales: ["Sep 25","Oct 25","Nov 25","Dec 25","Jan 26","Feb 26","Mar 26","Apr 26","May 26","Jun 26","Jul 26","Aug 26"]
      .map((m, i) => ({ month: m, revenue: [8200,10400,15300,21800,9100,8600,9800,10200,11900,12600,13400,5612][i], orders: [88,112,164,236,97,92,105,109,127,134,143,61][i] })),
    lastUpdated: new Date().toISOString(),
  };
}

function mockPromotions() {
  const now = new Date();
  const fmt = (d) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const in5 = new Date(+now + 5 * 86400000);
  const in13 = new Date(+now + 13 * 86400000);
  const in21 = new Date(+now + 21 * 86400000);
  const ago20 = new Date(+now - 20 * 86400000);
  const ago6 = new Date(+now - 6 * 86400000);
  return {
    promotions: [
      {
        id: "mock-1", name: "Bahama Mama Summer Bundle", audience: "Ecommerce",
        start: fmt(ago20), end: fmt(in5), startISO: ago20.toISOString(), endISO: in5.toISOString(),
        details: "15% off all Bahama Mama bundles.\n\nPromo Code / Item: BAHAMA15",
        promoCode: "BAHAMA15", upload: "", contact: "marketing@schmidthaus.com",
        status: "active", daysLeft: 5,
      },
      {
        id: "mock-2", name: "Oktoberfest Pre-Order Launch", audience: "Restaurant / Ecommerce",
        start: fmt(in13), end: fmt(in21), startISO: in13.toISOString(), endISO: in21.toISOString(),
        details: "Early-bird pre-orders for Oktoberfest party platters.",
        promoCode: "", upload: "", contact: "marketing@schmidthaus.com",
        status: "upcoming", daysLeft: 21,
      },
      {
        id: "mock-3", name: "Cream Puff Day Flash Sale", audience: "Restaurant",
        start: fmt(new Date(+now - 9 * 86400000)), end: fmt(ago6),
        startISO: new Date(+now - 9 * 86400000).toISOString(), endISO: ago6.toISOString(),
        details: "BOGO cream puffs in-store.\n\nPromo Code / Item: In-store only",
        promoCode: "In-store only", upload: "", contact: "",
        status: "ended", daysLeft: -6,
      },
    ],
    lastUpdated: new Date().toISOString(),
  };
}

function mockAnalytics() {
  return {
    thisWeek: { sessions: 4820, users: 3910, pageViews: 11240 },
    lastWeek: { sessions: 4275, users: 3512, pageViews: 10130 },
    sessionsChangePercent: 12.7,
    topPages: [
      { page: "/", views: 3120 },
      { page: "/menu", views: 2210 },
      { page: "/store", views: 1480 },
      { page: "/catering", views: 990 },
      { page: "/food-truck", views: 720 },
    ],
    topChannels: [
      { channel: "Organic Search", sessions: 2110 },
      { channel: "Direct", sessions: 1290 },
      { channel: "Organic Social", sessions: 740 },
      { channel: "Referral", sessions: 410 },
      { channel: "Email", sessions: 270 },
    ],
    keyPages: [
      { label: "Home", thisWeek: { views: 3120, users: 2480 }, lastWeek: { views: 2870, users: 2260 }, viewsChangePercent: 8.7 },
      { label: "Catering", thisWeek: { views: 990, users: 810 }, lastWeek: { views: 1080, users: 890 }, viewsChangePercent: -8.3 },
      { label: "Food Truck", thisWeek: { views: 720, users: 615 }, lastWeek: { views: 540, users: 470 }, viewsChangePercent: 33.3 },
    ],
    lastUpdated: new Date().toISOString(),
  };
}

function mockSocial() {
  const d = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  return {
    suggestions: [
      { holiday: "National Bratwurst Day", date: d(5), why: "A brat holiday is a bullseye for a sausage haus.", businessLines: ["restaurant", "foodtrucks"], promoIdea: "Free brat topping upgrade in-store and $2 off Bahama Mama 4-packs at schmidthaus.com.", samplePost: "It's National Bratwurst Day! 🌭 Celebrate with a Bahama Mama — in the Haus, at the truck, or shipped to your door. Order at schmidthaus.com" },
      { holiday: "Labor Day", date: d(20), why: "Big cookout weekend drives catering and ship-to-home orders.", businessLines: ["catering", "foodtrucks"], promoIdea: "Labor Day party packs with free local delivery over $100 via schmidthaus.com.", samplePost: "Make Labor Day easy: Schmidt's party packs feed the whole crew. Book catering or order online at schmidthaus.com 🇺🇸" },
      { holiday: "Oktoberfest (Columbus)", date: d(26), why: "The signature season for a German Village institution.", businessLines: ["restaurant", "catering", "foodtrucks"], promoIdea: "Oktoberfest pre-order bundles + food truck schedule promoted from schmidthaus.com.", samplePost: "Oktoberfest is coming! 🍺 Pre-order your Schmidt's party platters and find our truck schedule at schmidthaus.com. Prost!" },
      { holiday: "National Dessert Day", date: d(48), why: "Schmidt's jumbo cream puffs are the perfect hero product.", businessLines: ["restaurant"], promoIdea: "Cream puff flash sale with a limited flavor drop announced on socials.", samplePost: "National Dessert Day calls for a half-pound Schmidt's cream puff. 😍 Which flavor are you grabbing? schmidthaus.com" },
    ],
    model: "mock",
    generatedAt: new Date().toISOString(),
  };
}

// ================================================================ ROUTES
const safe = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error(err);
    res.status(err.status || 502).json({ error: err.message });
  }
};

app.get("/health", (req, res) =>
  res.json({ status: "ok", mock: MOCK, timestamp: new Date().toISOString() })
);

app.get("/api/ecwid", safe(() => getEcwidData()));
app.get("/api/promotions", safe(() => getPromotions()));
app.get("/api/analytics", safe(() => getAnalytics()));
app.get("/api/social", safe((req) => getSocialSuggestions(req.query.refresh === "1")));
app.get("/api/review", safe(async () => {
  const [ecwid, promos, analytics] = await Promise.all([
    getEcwidData().catch((e) => ({ error: e.message })),
    getPromotions().catch((e) => ({ error: e.message })),
    getAnalytics().catch((e) => ({ error: e.message })),
  ]);
  return buildReview({ ecwid, promos, analytics });
}));

// One call for the whole dashboard
app.get("/api/all", safe(async () => {
  const [ecwid, promotions, analytics, social] = await Promise.all([
    getEcwidData().catch((e) => ({ error: e.message })),
    getPromotions().catch((e) => ({ error: e.message })),
    getAnalytics().catch((e) => ({ error: e.message })),
    getSocialSuggestions().catch((e) => ({ error: e.message, suggestions: [] })),
  ]);
  return {
    ecwid, promotions, analytics, social,
    review: buildReview({ ecwid, promos: promotions, analytics }),
    mock: MOCK,
    generatedAt: new Date().toISOString(),
  };
}));

// Diagnostics carried over from the promo proxy
app.get("/api/pipelines", safe(async () => {
  if (!GHL_PIT) throw new Error("GHL_PIT not configured");
  const data = await ghlGet(`/opportunities/pipelines?locationId=${encodeURIComponent(GHL_LOCATION_ID)}`);
  return {
    chosenScope: await resolvePromoScope(),
    lookingFor: { pipelineName: PROMO_PIPELINE_NAME, stageName: PROMO_STAGE_NAME },
    pipelines: (data.pipelines || []).map((p) => ({
      id: p.id, name: p.name,
      stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })),
    })),
  };
}));

app.get("/api/custom-fields", safe(async () => {
  if (!GHL_PIT) throw new Error("GHL_PIT not configured");
  const data = await ghlGet(`/locations/${encodeURIComponent(GHL_LOCATION_ID)}/customFields?model=opportunity`);
  return {
    customFields: (data.customFields || []).map((f) => ({
      id: f.id, name: f.name, fieldKey: f.fieldKey, dataType: f.dataType,
    })),
  };
}));

app.listen(PORT, () => {
  console.log(`\nSchmidt's Marketing Hot Sheet running on port ${PORT}`);
  console.log(`   Mock mode:  ${MOCK ? "ON (sample data)" : "off"}`);
  console.log(`   Ecwid:      ${ECWID_API_TOKEN ? "configured" : "NOT configured"} (store ${ECWID_STORE_ID})`);
  console.log(`   GHL:        ${GHL_PIT ? "configured" : "NOT configured"} (location ${GHL_LOCATION_ID})`);
  console.log(`   GA4:        ${GA4_PROPERTY_ID && GA_CONFIGURED ? `configured (${OAUTH_CONFIGURED ? "OAuth" : "service account"})` : "NOT configured"}`);
  console.log(`   OpenAI:     ${OPENAI_API_KEY ? "configured" : "NOT configured"} (${OPENAI_MODEL})\n`);
});
