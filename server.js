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
  BRAND_NAME = "Schmidt's Sausage Haus",
  SITE_URL = "schmidthaus.com",
  PROMO_FORM_URL = "https://api.leadconnectorhq.com/widget/form/HiSs6ID0Yw8nu5ISjech",
  BANQUET_PIPELINE_NAME = "Banquet House Request",
  CATERING_PIPELINE_NAMES = "Catering Menu Request,Catering Requests",
  GA4_PROPERTY_ID = "",
  GOOGLE_SERVICE_ACCOUNT_JSON = "",
  GOOGLE_OAUTH_REFRESH_TOKEN = "",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  ALLOWED_ORIGIN = "*",
  CACHE_SECONDS = "300",
  ADMIN_PASSWORD = "",
  ADMIN_SESSION_SECRET = "",
  AUTO_RECOVERY = "false",
  AUTO_RECOVERY_COUPON = "",
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

// The three toggleable stat periods: last 7 days, month to date, year to date
// — each with a comparable previous period.
function buildPeriods() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86400000;
  const p7Start = new Date(+startOfToday - 6 * day);
  return {
    p7: {
      start: p7Start, end: null,
      prevStart: new Date(+p7Start - 7 * day), prevEnd: p7Start,
    },
    mtd: {
      start: new Date(now.getFullYear(), now.getMonth(), 1), end: null,
      prevStart: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      prevEnd: new Date(now.getFullYear(), now.getMonth() - 1, now.getDate() + 1),
    },
    ytd: {
      start: new Date(now.getFullYear(), 0, 1), end: null,
      prevStart: new Date(now.getFullYear() - 1, 0, 1),
      prevEnd: new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1),
    },
  };
}

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

async function ecwidWrite(method, endpoint, body) {
  const resp = await fetch(`${ECWID_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${ECWID_API_TOKEN}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await resp.text().catch(() => "");
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const err = new Error(`Ecwid API ${resp.status}: ${(data.errorMessage || text).slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// Uploads raw image bytes straight to Ecwid (no multipart, no extra deps).
// Ecwid takes the file as the request body: POST /products/{id}/image
async function ecwidUploadImage(endpoint, buffer, contentType) {
  const resp = await fetch(`${ECWID_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ECWID_API_TOKEN}`,
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": String(buffer.length),
    },
    body: buffer,
  });
  const text = await resp.text().catch(() => "");
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const err = new Error(`Ecwid image upload ${resp.status}: ${(data.errorMessage || text).slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return data;
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

  // Toggleable periods: last 7 days / month to date / year to date
  const P = buildPeriods();
  const periods = {};
  for (const key of ["p7", "mtd", "ytd"]) {
    const cur = between(P[key].start);
    const prev = between(P[key].prevStart, P[key].prevEnd);
    periods[key] = {
      totalOrders: cur.length,
      totalRevenue: revenue(cur),
      orderStatus: orderStatusCounts(cur),
      topProducts: topProducts(orders, P[key].start),
      prev: { totalOrders: prev.length, totalRevenue: revenue(prev) },
    };
  }

  return remember("ecwid", {
    periods,
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

async function ghlPost(pathName, body, version = GHL_VERSION) {
  const resp = await fetch(`${GHL_BASE}${pathName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GHL_PIT}`, Version: version,
      Accept: "application/json", "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text().catch(() => "");
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const err = new Error(`GHL API ${resp.status}: ${(data.message || text).toString().slice(0, 250)}`);
    err.status = resp.status;
    throw err;
  }
  return data;
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

async function getPipelines() {
  const data = await ghlGet(
    `/opportunities/pipelines?locationId=${encodeURIComponent(GHL_LOCATION_ID)}`
  );
  return data.pipelines || [];
}

async function resolvePromoScope() {
  if (promoScope) return promoScope;
  const pipelines = await getPipelines();
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

// ---------------- Lead counts from other GHL pipelines ----------------
// Banquet House Request pipeline + combined Catering Menu Request /
// Catering Requests pipelines, counted by opportunity createdAt per period.

async function fetchAllOppsForPipeline(pipelineId) {
  const all = [];
  let path2 = `/opportunities/search?location_id=${encodeURIComponent(GHL_LOCATION_ID)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=100`;
  for (let page = 0; page < 20; page++) {
    const data = await ghlGet(path2);
    const opps = data.opportunities || [];
    all.push(...opps);
    const next = data.meta?.nextPageUrl;
    if (!next || opps.length === 0) break;
    try {
      const u = new URL(next);
      path2 = u.pathname + u.search;
    } catch { break; }
  }
  return all;
}

async function getLeads() {
  if (MOCK) return mockLeads();
  if (!GHL_PIT) return { error: "GHL_PIT not configured" };
  const hit = cached("leads");
  if (hit) return hit;

  const pipelines = await getPipelines();
  const matchPipes = (names) => {
    const seen = new Set();
    const out = [];
    for (const needle of names) {
      const n = needle.toLowerCase().trim();
      if (!n) continue;
      for (const p of pipelines) {
        if ((p.name || "").toLowerCase().includes(n) && !seen.has(p.id)) {
          seen.add(p.id);
          out.push(p);
        }
      }
    }
    return out;
  };

  const P = buildPeriods();
  const countGroup = async (pipes) => {
    let opps = [];
    for (const p of pipes) opps = opps.concat(await fetchAllOppsForPipeline(p.id));
    const createdBetween = (a, b) =>
      opps.filter((o) => {
        const d = new Date(o.createdAt || o.dateAdded || 0);
        return d >= a && (!b || d < b);
      }).length;
    const periods = {};
    for (const k of ["p7", "mtd", "ytd"]) {
      periods[k] = {
        count: createdBetween(P[k].start),
        prev: createdBetween(P[k].prevStart, P[k].prevEnd),
      };
    }
    return { total: opps.length, periods, pipelines: pipes.map((p) => p.name) };
  };

  const [banquet, catering] = await Promise.all([
    countGroup(matchPipes([BANQUET_PIPELINE_NAME])),
    countGroup(matchPipes(CATERING_PIPELINE_NAMES.split(","))),
  ]);

  return remember("leads", { banquet, catering, lastUpdated: new Date().toISOString() });
}

function mockLeads() {
  return {
    banquet: {
      total: 87,
      periods: {
        p7: { count: 6, prev: 4 },
        mtd: { count: 9, prev: 7 },
        ytd: { count: 87, prev: 74 },
      },
      pipelines: ["Banquet House Request"],
    },
    catering: {
      total: 142,
      periods: {
        p7: { count: 11, prev: 13 },
        mtd: { count: 16, prev: 14 },
        ytd: { count: 142, prev: 118 },
      },
      pipelines: ["Catering Menu Request", "Catering Requests"],
    },
    lastUpdated: new Date().toISOString(),
  };
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

  const today = new Date();
  const P = buildPeriods();
  const PERIOD_KEYS = ["p7", "mtd", "ytd"];
  const dayBefore = (d) => new Date(+d - 86400000);
  const curRange = (k) => ({ startDate: iso(P[k].start), endDate: iso(today), name: k });
  const prevRange = (k) => ({
    startDate: iso(P[k].prevStart), endDate: iso(dayBefore(P[k].prevEnd)), name: k + "prev",
  });

  const TOTAL_METRICS = [
    { name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" },
    { name: "addToCarts" }, { name: "ecommercePurchases" },
  ];

  // GA4 allows max 4 date ranges per request, so totals are split in two.
  const [totalsA, totalsB, pages, channels, keyCur, keyPrev] = await Promise.all([
    ga4RunReport({
      dateRanges: [curRange("p7"), prevRange("p7"), curRange("mtd"), prevRange("mtd")],
      metrics: TOTAL_METRICS,
    }),
    ga4RunReport({
      dateRanges: [curRange("ytd"), prevRange("ytd")],
      metrics: TOTAL_METRICS,
    }),
    ga4RunReport({
      dateRanges: PERIOD_KEYS.map(curRange),
      dimensions: [{ name: "pageTitle" }],
      metrics: [{ name: "screenPageViews" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 1000,
    }),
    ga4RunReport({
      dateRanges: PERIOD_KEYS.map(curRange),
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 100,
    }),
    ga4RunReport({
      dateRanges: PERIOD_KEYS.map(curRange),
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      limit: 1000,
    }),
    ga4RunReport({
      dateRanges: PERIOD_KEYS.map(prevRange),
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      limit: 1000,
    }),
  ]);

  // ---- totals per period (with prev + cart abandonment rate) ----
  const totalsByRange = {};
  for (const row of [...(totalsA.rows || []), ...(totalsB.rows || [])]) {
    const range = row.dimensionValues?.[0]?.value || "";
    totalsByRange[range] = {
      sessions: Number(row.metricValues?.[0]?.value || 0),
      users: Number(row.metricValues?.[1]?.value || 0),
      pageViews: Number(row.metricValues?.[2]?.value || 0),
      addToCarts: Number(row.metricValues?.[3]?.value || 0),
      purchases: Number(row.metricValues?.[4]?.value || 0),
    };
  }
  const abandonRate = (t) =>
    t && t.addToCarts > 0
      ? Number((((t.addToCarts - t.purchases) / t.addToCarts) * 100).toFixed(1))
      : null;
  const EMPTY_T = { sessions: 0, users: 0, pageViews: 0, addToCarts: 0, purchases: 0 };
  const periods = {};
  for (const k of PERIOD_KEYS) {
    const cur = totalsByRange[k] || EMPTY_T;
    const prev = totalsByRange[k + "prev"] || EMPTY_T;
    periods[k] = {
      ...cur,
      cartAbandonmentRate: abandonRate(cur),
      prev: { ...prev, cartAbandonmentRate: abandonRate(prev) },
    };
  }

  // ---- top pages / channels per period ----
  const splitByRange = (report, mapRow) => {
    const out = { p7: [], mtd: [], ytd: [] };
    for (const row of report.rows || []) {
      const range = row.dimensionValues?.[1]?.value || "";
      if (out[range]) out[range].push(mapRow(row));
    }
    for (const k of PERIOD_KEYS) out[k] = out[k].slice(0, 5);
    return out;
  };
  const topPages = splitByRange(pages, (r) => ({
    // GA4 gives the browser title; trim the site name most themes append.
    page: String(r.dimensionValues[0].value || "").split(" | ")[0].split(" - ")[0].trim() || "(untitled)",
    views: Number(r.metricValues[0].value),
  }));
  const CHANNEL_LABELS = { Unassigned: "Smart 1 Targeted Display" };
  const topChannels = splitByRange(channels, (r) => ({
    channel: CHANNEL_LABELS[r.dimensionValues[0].value] || r.dimensionValues[0].value,
    sessions: Number(r.metricValues[0].value),
  }));

  // ---- key pages (home / catering / food truck) per period ----
  const KEY_PAGE_GROUPS = [
    { label: "Home", match: (p) => p === "/" || p === "/home" || p.startsWith("/?") },
    { label: "Catering", match: (p) => p.includes("catering") },
    { label: "Food Truck", match: (p) => p.includes("truck") },
  ];
  const keyPages = {};
  for (const k of PERIOD_KEYS) {
    keyPages[k] = KEY_PAGE_GROUPS.map((g) => ({
      label: g.label,
      thisWeek: { views: 0, users: 0 },   // "current period" (name kept for UI compat)
      lastWeek: { views: 0, users: 0 },   // "previous period"
    }));
  }
  const addKeyRows = (report, bucket, stripPrev) => {
    for (const row of report.rows || []) {
      const pagePath = (row.dimensionValues?.[0]?.value || "").toLowerCase();
      let range = row.dimensionValues?.[1]?.value || "";
      if (stripPrev) range = range.replace(/prev$/, "");
      if (!keyPages[range]) continue;
      const views = Number(row.metricValues?.[0]?.value || 0);
      const users = Number(row.metricValues?.[1]?.value || 0);
      for (let i = 0; i < KEY_PAGE_GROUPS.length; i++) {
        if (KEY_PAGE_GROUPS[i].match(pagePath)) {
          keyPages[range][i][bucket].views += views;
          keyPages[range][i][bucket].users += users;
          break;
        }
      }
    }
  };
  addKeyRows(keyCur, "thisWeek", false);
  addKeyRows(keyPrev, "lastWeek", true);
  for (const k of PERIOD_KEYS) {
    keyPages[k].forEach((kp) => {
      kp.viewsChangePercent = pct(kp.thisWeek.views, kp.lastWeek.views);
    });
  }

  // Legacy weekly fields (used by the Review tab logic) map to the 7-day period
  const thisWeek = { sessions: periods.p7.sessions, users: periods.p7.users, pageViews: periods.p7.pageViews };
  const lastWeek = { sessions: periods.p7.prev.sessions, users: periods.p7.prev.users, pageViews: periods.p7.prev.pageViews };

  return remember("ga4", {
    periods,
    thisWeek,
    lastWeek,
    sessionsChangePercent: pct(thisWeek.sessions, lastWeek.sessions),
    topPages,
    topChannels,
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
  const mkPeriod = (o, r, po, pr, status, top) => ({
    totalOrders: o, totalRevenue: r, orderStatus: status, topProducts: top,
    prev: { totalOrders: po, totalRevenue: pr },
  });
  const topWeek = [
    { productId: 1, name: "Bahama Mama Sausages (4-pack)", quantity: 26, revenue: 624.0 },
    { productId: 2, name: "Jumbo Cream Puff Kit", quantity: 18, revenue: 522.0 },
    { productId: 3, name: "German Potato Salad (Family Size)", quantity: 15, revenue: 285.0 },
    { productId: 4, name: "Sauerkraut Balls (Frozen, 24ct)", quantity: 12, revenue: 216.0 },
    { productId: 5, name: "Schmidt's Signature Mustard", quantity: 11, revenue: 98.45 },
  ];
  const topYear = [
    { productId: 1, name: "Bahama Mama Sausages (4-pack)", quantity: 512, revenue: 12288.0 },
    { productId: 2, name: "Jumbo Cream Puff Kit", quantity: 388, revenue: 11252.0 },
    { productId: 3, name: "German Potato Salad (Family Size)", quantity: 240, revenue: 4560.0 },
    { productId: 4, name: "Sauerkraut Balls (Frozen, 24ct)", quantity: 198, revenue: 3564.0 },
  ];
  return {
    periods: {
      p7: mkPeriod(42, 3860.5, 38, 3421.75,
        { pending: 3, processing: 6, shipped: 21, delivered: 12, other: 0 }, topWeek),
      mtd: mkPeriod(61, 5612.4, 54, 4890.2,
        { pending: 3, processing: 8, shipped: 30, delivered: 20, other: 0 },
        topWeek.map((p) => ({ ...p, quantity: Math.round(p.quantity * 1.5), revenue: p.revenue * 1.5 }))),
      ytd: mkPeriod(1240, 126540.2, 1105, 112380.6,
        { pending: 3, processing: 8, shipped: 640, delivered: 589, other: 0 }, topYear),
    },
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
  const mkTotals = (mult) => ({
    sessions: Math.round(4820 * mult), users: Math.round(3910 * mult),
    pageViews: Math.round(11240 * mult),
    addToCarts: Math.round(310 * mult), purchases: Math.round(96 * mult),
  });
  const withRate = (t) => ({
    ...t,
    cartAbandonmentRate: Number((((t.addToCarts - t.purchases) / t.addToCarts) * 100).toFixed(1)),
  });
  const mkPages = (mult) => [
    { page: "Schmidt's Sausage Haus — Home", views: Math.round(3120 * mult) },
    { page: "Menu", views: Math.round(2210 * mult) },
    { page: "Online Store", views: Math.round(1480 * mult) },
    { page: "Catering", views: Math.round(990 * mult) },
    { page: "Food Trucks", views: Math.round(720 * mult) },
  ];
  const mkChannels = (mult) => [
    { channel: "Organic Search", sessions: Math.round(2110 * mult) },
    { channel: "Direct", sessions: Math.round(1290 * mult) },
    { channel: "Organic Social", sessions: Math.round(740 * mult) },
    { channel: "Referral", sessions: Math.round(410 * mult) },
    { channel: "Email", sessions: Math.round(270 * mult) },
    { channel: "Smart 1 Targeted Display", sessions: Math.round(180 * mult) },
  ];
  const mkKey = (mult) => [
    { label: "Home", thisWeek: { views: Math.round(3120 * mult), users: Math.round(2480 * mult) }, lastWeek: { views: Math.round(2870 * mult), users: Math.round(2260 * mult) }, viewsChangePercent: 8.7 },
    { label: "Catering", thisWeek: { views: Math.round(990 * mult), users: Math.round(810 * mult) }, lastWeek: { views: Math.round(1080 * mult), users: Math.round(890 * mult) }, viewsChangePercent: -8.3 },
    { label: "Food Truck", thisWeek: { views: Math.round(720 * mult), users: Math.round(615 * mult) }, lastWeek: { views: Math.round(540 * mult), users: Math.round(470 * mult) }, viewsChangePercent: 33.3 },
  ];
  return {
    periods: {
      p7: { ...withRate(mkTotals(1)), prev: withRate(mkTotals(0.89)) },
      mtd: { ...withRate(mkTotals(1.6)), prev: withRate(mkTotals(1.5)) },
      ytd: { ...withRate(mkTotals(32)), prev: withRate(mkTotals(29)) },
    },
    thisWeek: { sessions: 4820, users: 3910, pageViews: 11240 },
    lastWeek: { sessions: 4275, users: 3512, pageViews: 10130 },
    sessionsChangePercent: 12.7,
    topPages: { p7: mkPages(1), mtd: mkPages(1.6), ytd: mkPages(32) },
    topChannels: { p7: mkChannels(1), mtd: mkChannels(1.6), ytd: mkChannels(32) },
    keyPages: { p7: mkKey(1), mtd: mkKey(1.6), ytd: mkKey(32) },
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

// Wrap async route handlers with JSON error handling
const safe = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error(err);
    res.status(err.status || 502).json({ error: err.message });
  }
};

// ================================================================ ADMIN (owner-only)
// Owner tools — add/edit products (with photo upload), toggle products on and
// off, discount codes, abandoned-cart recovery, and a monthly sales +
// state/local tax report, all through the Ecwid API. These now live INSIDE
// the main dashboard menu: the tabs appear once you sign in with
// ADMIN_PASSWORD, and stay hidden otherwise.

const ADMIN_SECRET = ADMIN_SESSION_SECRET || ADMIN_PASSWORD || "disabled";
const ADMIN_COOKIE = "s1admin";
const ADMIN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const signExp = (exp) =>
  crypto.createHmac("sha256", ADMIN_SECRET).update(String(exp)).digest("hex");

function isAdminRequest(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => {
      const i = c.indexOf("=");
      return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    })
  );
  const val = cookies[ADMIN_COOKIE];
  if (!val) return false;
  const [exp, sig] = val.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signExp(exp)), Buffer.from(sig));
  } catch { return false; }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(404).json({ error: "Admin area not enabled (set ADMIN_PASSWORD)." });
  if (!isAdminRequest(req)) return res.status(401).json({ error: "Not signed in." });
  next();
}

// The old standalone /admin page is gone — owner tools are tabs in the main
// menu now. Keep the URL working for anyone with it bookmarked.
app.get("/admin", (req, res) => res.redirect("/#adminProducts"));

app.post("/admin/api/login", express.json(), (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(404).json({ error: "Admin area not enabled." });
  const pw = String(req.body?.password || "");
  const a = Buffer.from(pw);
  const b = Buffer.from(ADMIN_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: "Wrong password." });
  const exp = Date.now() + ADMIN_TTL_MS;
  const secure = req.headers["x-forwarded-proto"] === "https" || req.secure ? " Secure;" : "";
  res.setHeader("Set-Cookie",
    `${ADMIN_COOKIE}=${exp}.${signExp(exp)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${Math.floor(ADMIN_TTL_MS / 1000)}`);
  res.json({ ok: true });
});

app.post("/admin/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/admin/api/session", (req, res) =>
  res.json({ signedIn: !!ADMIN_PASSWORD && isAdminRequest(req), enabled: !!ADMIN_PASSWORD, mock: MOCK }));

// ---- Products: list + toggle ----
let mockProductList = null;
function getMockProducts() {
  if (!mockProductList) {
    mockProductList = [
      { id: 101, name: "Bahama Mama Sausages (4-pack)", sku: "BM-4PK", price: 24.0, enabled: true, quantity: 120, unlimited: false, weight: 2.5, description: "<h3>About</h3><p>Our famous Bahama Mamas.</p>", imageUrl: "", url: "https://schmidthaus.com/store/p/bahama-mama", categoryIds: [1], defaultCategoryId: 1 },
      { id: 102, name: "Jumbo Cream Puff Kit", sku: "CP-KIT", price: 29.0, enabled: true, quantity: 45, unlimited: false },
      { id: 103, name: "German Potato Salad (Family Size)", sku: "GPS-FAM", price: 19.0, enabled: true, quantity: 0, unlimited: true },
      { id: 104, name: "Sauerkraut Balls (Frozen, 24ct)", sku: "SKB-24", price: 18.0, enabled: false, quantity: 60, unlimited: false },
      { id: 105, name: "Schmidt's Signature Mustard", sku: "MUST-01", price: 8.95, enabled: true, quantity: 300, unlimited: false },
    ];
  }
  return mockProductList;
}

app.get("/admin/api/products", requireAdmin, safe(async () => {
  if (MOCK) return { products: getMockProducts(), mock: true };
  if (!ECWID_API_TOKEN) throw new Error("ECWID_API_TOKEN not configured");
  const items = await ecwidPageAll("/products");
  return {
    products: items.map((p) => ({
      id: p.id, name: p.name, sku: p.sku, price: p.price,
      enabled: p.enabled, quantity: p.quantity, unlimited: p.unlimited,
      weight: p.weight, description: p.description || "",
      imageUrl: p.thumbnailUrl || p.imageUrl || p.smallThumbnailUrl || "",
      url: p.url || "",
      categoryIds: p.categoryIds || [],
      defaultCategoryId: p.defaultCategoryId || null,
    })),
  };
}));

app.put("/admin/api/products/:id/enabled", requireAdmin, express.json(), safe(async (req) => {
  const id = req.params.id;
  const enabled = !!req.body?.enabled;
  if (MOCK) {
    const p = getMockProducts().find((x) => String(x.id) === String(id));
    if (p) p.enabled = enabled;
    return { ok: true, id, enabled, mock: true };
  }
  await ecwidWrite("PUT", `/products/${encodeURIComponent(id)}`, { enabled });
  simpleCache.delete("ecwid");
  return { ok: true, id, enabled };
}));

// ---- Add a product ----
app.post("/admin/api/products", requireAdmin, express.json(), safe(async (req) => {
  const b = req.body || {};
  if (!b.name || b.price === undefined || b.price === "")
    throw Object.assign(new Error("Name and price are required."), { status: 400 });
  const product = {
    name: String(b.name).slice(0, 255),
    price: Number(b.price),
    enabled: b.enabled !== false,
  };
  if (b.sku) product.sku = String(b.sku).slice(0, 64);
  if (b.description) product.description = String(b.description);
  if (b.weight !== undefined && b.weight !== "") product.weight = Number(b.weight);
  if (b.quantity !== undefined && b.quantity !== "") {
    product.quantity = parseInt(b.quantity, 10);
    product.unlimited = false;
  } else {
    product.unlimited = true;
  }
  const newCat = Number(b.categoryId);
  if (newCat) {
    product.categoryIds = [newCat];
    product.defaultCategoryId = newCat;
  }
  if (MOCK) {
    const p = { id: Math.floor(Math.random() * 0 + Date.now() % 100000), ...product };
    getMockProducts().unshift(p);
    return { ok: true, product: p, mock: true };
  }
  const created = await ecwidWrite("POST", "/products", product);
  simpleCache.delete("ecwid");
  return { ok: true, product: { id: created.id, ...product } };
}));

// ---- Update an existing product ----
// Only the fields actually sent are changed, so a blank box never wipes
// something out by accident.
app.put("/admin/api/products/:id", requireAdmin, express.json(), safe(async (req) => {
  const id = req.params.id;
  const b = req.body || {};
  const update = {};
  if (b.name !== undefined && String(b.name).trim() !== "") update.name = String(b.name).slice(0, 255);
  if (b.price !== undefined && b.price !== "") update.price = Number(b.price);
  if (b.sku !== undefined) update.sku = String(b.sku).slice(0, 64);
  if (b.description !== undefined) update.description = String(b.description);
  if (b.weight !== undefined && b.weight !== "") update.weight = Number(b.weight);
  if (b.enabled !== undefined) update.enabled = !!b.enabled;
  if (b.categoryId !== undefined) {
    const cat = Number(b.categoryId);
    if (cat) {
      update.categoryIds = [cat];
      update.defaultCategoryId = cat;
    } else {
      update.categoryIds = [];          // "no category" clears it
    }
  }
  if (b.quantity !== undefined) {
    if (b.quantity === "" || b.quantity === null) {
      update.unlimited = true;
    } else {
      update.quantity = parseInt(b.quantity, 10);
      update.unlimited = false;
    }
  }
  if (!Object.keys(update).length)
    throw Object.assign(new Error("Nothing to update."), { status: 400 });

  if (MOCK) {
    const p = getMockProducts().find((x) => String(x.id) === String(id));
    if (!p) throw Object.assign(new Error("Product not found."), { status: 404 });
    Object.assign(p, update);
    return { ok: true, product: p, mock: true };
  }
  await ecwidWrite("PUT", `/products/${encodeURIComponent(id)}`, update);
  simpleCache.delete("ecwid");
  return { ok: true, id, updated: Object.keys(update) };
}));

// ---- Product photo upload ----
// The browser posts the raw image bytes with the file's own content type;
// we hand the same bytes to Ecwid. `?gallery=1` adds it to the gallery
// instead of replacing the main photo.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const rawImage = express.raw({ type: () => true, limit: MAX_IMAGE_BYTES });

app.post("/admin/api/products/:id/image", requireAdmin, rawImage, safe(async (req) => {
  const id = req.params.id;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length)
    throw Object.assign(new Error("No image data received."), { status: 400 });
  const type = (req.headers["content-type"] || "").split(";")[0];
  if (!/^image\//.test(type))
    throw Object.assign(new Error(`Unsupported file type "${type || "unknown"}" — upload a JPG, PNG, GIF or WebP.`), { status: 400 });

  const gallery = req.query.gallery === "1";
  if (MOCK) {
    const p = getMockProducts().find((x) => String(x.id) === String(id));
    if (p && !gallery) p.imageUrl = `data:${type};base64,${buf.toString("base64")}`;
    return { ok: true, mock: true, bytes: buf.length, gallery };
  }
  const out = await ecwidUploadImage(
    `/products/${encodeURIComponent(id)}/${gallery ? "gallery" : "image"}`, buf, type);
  simpleCache.delete("ecwid");
  return { ok: true, bytes: buf.length, gallery, result: out };
}));

app.delete("/admin/api/products/:id/image", requireAdmin, safe(async (req) => {
  const id = req.params.id;
  if (MOCK) {
    const p = getMockProducts().find((x) => String(x.id) === String(id));
    if (p) p.imageUrl = "";
    return { ok: true, mock: true };
  }
  await ecwidWrite("DELETE", `/products/${encodeURIComponent(id)}/image`, undefined);
  simpleCache.delete("ecwid");
  return { ok: true };
}));

// ---- Store categories (for the "move to category" bulk action) ----
app.get("/admin/api/categories", requireAdmin, safe(async () => {
  if (MOCK) {
    return { categories: [
      { id: 1, name: "Wine", parentId: null, enabled: true },
      { id: 2, name: "Merchandise", parentId: null, enabled: true },
      { id: 3, name: "Events & Tickets", parentId: null, enabled: true },
    ] };
  }
  if (!ECWID_API_TOKEN) throw new Error("ECWID_API_TOKEN not configured");
  const items = await ecwidPageAll("/categories");
  return {
    categories: items
      .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId || null, enabled: c.enabled }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}));

// ---- Create a category without leaving the dashboard ----
app.post("/admin/api/categories", requireAdmin, express.json(), safe(async (req) => {
  const name = String(req.body?.name || "").trim().slice(0, 120);
  if (!name) throw Object.assign(new Error("Give the category a name."), { status: 400 });
  if (MOCK) {
    const c = { id: Date.now() % 100000, name, parentId: null, enabled: true };
    return { ok: true, category: c, mock: true };
  }
  if (!ECWID_API_TOKEN) throw new Error("ECWID_API_TOKEN not configured");
  const created = await ecwidWrite("POST", "/categories", { name, enabled: true });
  return { ok: true, category: { id: created.id, name, parentId: null, enabled: true } };
}));

// ---- Borrow the layout of an existing product description ----
// Product descriptions are HTML, and every store ends up with a house style —
// same headings, same bullet pattern, same spacing. This reads one product's
// description as the template and rewrites another product's copy into the
// same shape, so new products don't look out of place on the site.
app.post("/admin/api/products/style-description", requireAdmin, express.json(), safe(async (req) => {
  if (!OPENAI_API_KEY) throw Object.assign(new Error("OPENAI_API_KEY not configured."), { status: 503 });
  const sourceId = String(req.body?.sourceId || "");
  const name = String(req.body?.name || "").trim().slice(0, 200);
  const content = String(req.body?.content || "").trim().slice(0, 3000);
  if (!sourceId) throw Object.assign(new Error("Pick a product to copy the styling from."), { status: 400 });
  if (!name && !content) throw Object.assign(new Error("Add a product name or some description text first."), { status: 400 });

  let template = "";
  let templateName = "";
  if (MOCK) {
    templateName = "Sample product";
    template = '<h3>Tasting notes</h3><p>Bright and easy drinking.</p><ul><li>750ml</li><li>Off-dry</li></ul>';
  } else {
    const src = await ecwidGet(`/products/${encodeURIComponent(sourceId)}`);
    if (!src) throw Object.assign(new Error("Couldn't read that product."), { status: 404 });
    template = String(src.description || "");
    templateName = String(src.name || "");
    if (!template.trim())
      throw Object.assign(new Error(`"${templateName}" has no description to copy the styling from — pick another product.`), { status: 400 });
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `You lay out product descriptions for ${BRAND_NAME}'s online store. You are given the HTML of an ` +
            `existing product description that defines the house style. Copy its STRUCTURE exactly — the same ` +
            `tags, heading levels, ordering of sections, list style, inline styles and general length — but write ` +
            `the words for a different product. Keep any section headings the store uses (tasting notes, ` +
            `details, shipping and so on) when they make sense for the new product, and drop ones that don't. ` +
            `Never invent facts like vintages, ABV, awards, weights or allergens that you weren't given. ` +
            `Boilerplate lines in the template — shipping included, pickup only, club pricing, ticket terms — ` +
            `are claims about THAT product: keep one only if it plainly applies to the new product too, ` +
            `otherwise leave it out rather than repeating it. ` +
            `Return only JSON: {"html":"..."} where html is the finished description body — no <html>, <head> ` +
            `or <body> wrapper, and no markdown fences.`,
        },
        {
          role: "user",
          content:
            `HOUSE STYLE — the description HTML of "${templateName}":\n${template.slice(0, 4000)}\n\n` +
            `NEW PRODUCT NAME: ${name || "(untitled)"}\n` +
            `WHAT TO SAY (may be rough notes, plain text, or empty):\n${content || "(nothing supplied — write something short and factual from the product name alone)"}`,
        },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  let html = "";
  try { html = JSON.parse(data.choices[0].message.content).html || ""; } catch { throw new Error("The model returned something unreadable — try again."); }
  html = html.replace(/^```(?:html)?\s*|\s*```$/g, "").trim();
  if (!html) throw new Error("Nothing came back — try a different source product.");
  return { html, styledAfter: templateName, model: OPENAI_MODEL };
}));

// ---- Bulk actions on selected products ----
// One request instead of hundreds: the browser sends the ids and what to do,
// and this runs them a few at a time so Ecwid's rate limit stays happy. Every
// id reports back its own result, so a couple of failures don't hide the rest.
const BULK_ACTIONS = new Set(["enable", "disable", "delete", "category"]);

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

app.post("/admin/api/products/bulk", requireAdmin, express.json(), safe(async (req) => {
  const action = String(req.body?.action || "");
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const categoryId = req.body?.categoryId;

  if (!BULK_ACTIONS.has(action))
    throw Object.assign(new Error("Unknown bulk action."), { status: 400 });
  if (!ids.length)
    throw Object.assign(new Error("Nothing selected."), { status: 400 });
  if (ids.length > 500)
    throw Object.assign(new Error("That's more than 500 products at once — narrow it down a bit."), { status: 400 });
  if (action === "category" && (categoryId === undefined || categoryId === null || categoryId === ""))
    throw Object.assign(new Error("Pick a category first."), { status: 400 });

  const runOne = async (id) => {
    try {
      if (MOCK) {
        const list = getMockProducts();
        const i = list.findIndex((p) => String(p.id) === id);
        if (i < 0) throw new Error("Product not found.");
        if (action === "delete") list.splice(i, 1);
        else if (action === "enable") list[i].enabled = true;
        else if (action === "disable") list[i].enabled = false;
        else if (action === "category") list[i].categoryIds = [Number(categoryId)];
        return { id, ok: true };
      }
      if (action === "delete") {
        await ecwidWrite("DELETE", `/products/${encodeURIComponent(id)}`, undefined);
      } else if (action === "category") {
        // Moves the product: its categories are replaced with this one.
        await ecwidWrite("PUT", `/products/${encodeURIComponent(id)}`, {
          categoryIds: [Number(categoryId)],
          defaultCategoryId: Number(categoryId),
        });
      } else {
        await ecwidWrite("PUT", `/products/${encodeURIComponent(id)}`, { enabled: action === "enable" });
      }
      return { id, ok: true };
    } catch (e) {
      return { id, ok: false, error: e.message };
    }
  };

  const results = await inBatches(ids, 4, runOne);
  simpleCache.delete("ecwid");
  const failed = results.filter((r) => !r.ok);
  const done = results.length - failed.length;
  const verb = { enable: "turned on", disable: "turned off", delete: "deleted", category: "moved" }[action];
  return {
    ok: failed.length === 0,
    done,
    failed,
    message: failed.length
      ? `${done} of ${results.length} ${verb}; ${failed.length} failed (${failed[0].error})`
      : `${done} product${done === 1 ? "" : "s"} ${verb}.`,
  };
}));

// ---- Monthly sales + state/local tax breakdown ----
function classifyTaxName(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("state")) return "State";
  if (n.includes("county") || n.includes("city") || n.includes("local") ||
      n.includes("municipal") || n.includes("district") || n.includes("transit")) return "Local";
  return "Other";
}

app.get("/admin/api/sales", requireAdmin, safe(async (req) => {
  const month = String(req.query.month || "").match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const y = month ? Number(month[1]) : now.getFullYear();
  const m = month ? Number(month[2]) - 1 : now.getMonth();
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 1);
  const label = start.toLocaleString("en-US", { month: "long", year: "numeric" });

  if (MOCK) {
    const day = (n) => new Date(y, m, n).toISOString();
    return {
      month: label,
      counted: { PAID: 58, PARTIALLY_REFUNDED: 1 },
      excluded: { AWAITING_PAYMENT: 3, CANCELLED: 2, REFUNDED: 1 },
      orders: 59, grossSales: 6240.75, subtotal: 5480.2, shipping: 512.4, discounts: 231.85, totalTax: 462.15,
      taxes: [
        { name: "OH State Tax", type: "State", amount: 316.4, orders: 59 },
        { name: "Franklin County Tax", type: "Local", amount: 98.55, orders: 52 },
        { name: "COTA Transit Tax", type: "Local", amount: 47.2, orders: 52 },
      ],
      orderRows: [
        { order: "10241", date: day(2), customer: "amy@example.com", subtotal: 86.5, shipping: 12.95, discount: 0, tax: 7.79, total: 107.24, status: "PAID" },
        { order: "10242", date: day(5), customer: "jake@example.com", subtotal: 145.0, shipping: 0, discount: 21.75, tax: 9.63, total: 132.88, status: "PAID" },
        { order: "10243", date: day(11), customer: "maria@example.com", subtotal: 29.0, shipping: 8.5, discount: 0, tax: 2.93, total: 40.43, status: "PAID" },
        { order: "10244", date: day(17), customer: "sam@example.com", subtotal: 212.4, shipping: 18.0, discount: 0, tax: 18.02, total: 248.42, status: "PARTIALLY_REFUNDED" },
      ],
      mock: true,
    };
  }
  if (!ECWID_API_TOKEN) throw new Error("ECWID_API_TOKEN not configured");

  const orders = await ecwidPageAll("/orders");
  const COUNTED = new Set(["PAID", "PARTIALLY_REFUNDED"]);
  const counted = {}, excluded = {};
  const inMonth = orders.filter((o) => {
    const d = new Date(o.createDate);
    return d >= start && d < end;
  });
  const kept = [];
  for (const o of inMonth) {
    const st = o.paymentStatus || "UNKNOWN";
    if (COUNTED.has(st)) { counted[st] = (counted[st] || 0) + 1; kept.push(o); }
    else excluded[st] = (excluded[st] || 0) + 1;
  }

  let grossSales = 0, subtotal = 0, shipping = 0, discounts = 0, totalTax = 0;
  const taxMap = new Map(); // name -> { amount, orders:Set }
  const orderRows = [];
  for (const o of kept) {
    const oShipping = o.shippingOption?.shippingRate || 0;
    const oDiscount = (o.discount || 0) + (o.couponDiscount || 0) + (o.volumeDiscount || 0);
    const oItemTax = (o.items || []).reduce(
      (s, i) => s + (i.taxes || []).reduce((s2, t) => s2 + (t.total || 0), 0), 0);
    const oTax = typeof o.tax === "number" ? o.tax : oItemTax;
    grossSales += o.total || 0;
    subtotal += o.subtotal || 0;
    shipping += oShipping;
    discounts += oDiscount;
    if (typeof o.tax === "number") totalTax += o.tax;
    orderRows.push({
      order: String(o.orderNumber || o.vendorOrderNumber || o.id || ""),
      date: o.createDate,
      customer: o.email || o.billingPerson?.name || "",
      subtotal: o.subtotal || 0,
      shipping: oShipping,
      discount: oDiscount,
      tax: oTax,
      total: o.total || 0,
      status: o.paymentStatus || "",
    });

    const addTax = (name, amount) => {
      if (!amount) return;
      const key = name || "Tax";
      const t = taxMap.get(key) || { amount: 0, orders: new Set() };
      t.amount += amount;
      t.orders.add(o.id);
      taxMap.set(key, t);
    };
    for (const item of o.items || []) {
      for (const t of item.taxes || []) addTax(t.name, t.total || 0);
    }
    // shipping-level taxes, if itemized on the order
    for (const t of o.taxesOnShipping || []) {
      if (t && typeof t === "object") addTax(t.name, t.total || 0);
    }
  }
  // If the order-level tax field wasn't present, fall back to the itemized sum
  const itemizedTotal = [...taxMap.values()].reduce((s, t) => s + t.amount, 0);
  if (!totalTax || totalTax < itemizedTotal * 0.5) totalTax = itemizedTotal;

  orderRows.sort((a, b) => new Date(a.date) - new Date(b.date));

  return {
    month: label,
    counted, excluded,
    orders: kept.length,
    grossSales, subtotal, shipping, discounts, totalTax,
    taxes: [...taxMap.entries()]
      .map(([name, t]) => ({ name, type: classifyTaxName(name), amount: Number(t.amount.toFixed(2)), orders: t.orders.size }))
      .sort((a, b) => b.amount - a.amount),
    orderRows,
  };
}));

// ---- Discount codes (Ecwid coupons) ----
let mockCoupons = null;
function getMockCoupons() {
  if (!mockCoupons) {
    mockCoupons = [
      { id: 1, name: "Bahama Mama Summer", code: "BAHAMA15", discountType: "PERCENT", discount: 15, status: "ACTIVE", usesLimit: "UNLIMITED", orderCount: 34, expirationDate: "2026-08-16 23:59:59" },
      { id: 2, name: "Free Shipping September", code: "SHIPFREE", discountType: "SHIPPING", discount: 0, status: "PAUSED", usesLimit: "ONE_PER_CUSTOMER", orderCount: 0, expirationDate: "" },
    ];
  }
  return mockCoupons;
}

app.get("/admin/api/coupons", requireAdmin, safe(async () => {
  if (MOCK) return { coupons: getMockCoupons(), mock: true };
  if (!ECWID_API_TOKEN) throw new Error("ECWID_API_TOKEN not configured");
  const items = await ecwidPageAll("/discount_coupons");
  return {
    coupons: items.map((c) => ({
      id: c.id, name: c.name, code: c.code, discountType: c.discountType,
      discount: c.discount, status: c.status, usesLimit: c.usesLimit,
      orderCount: c.orderCount, launchDate: c.launchDate, expirationDate: c.expirationDate,
      repeatCustomerOnly: c.repeatCustomerOnly,
    })),
  };
}));

app.post("/admin/api/coupons", requireAdmin, express.json(), safe(async (req) => {
  const b = req.body || {};
  if (!b.name || !b.code) throw Object.assign(new Error("Name and code are required."), { status: 400 });
  const TYPES = ["PERCENT", "ABS", "SHIPPING", "PERCENT_AND_SHIPPING", "ABS_AND_SHIPPING"];
  const coupon = {
    name: String(b.name).slice(0, 128),
    code: String(b.code).toUpperCase().replace(/\s+/g, ""),
    discountType: TYPES.includes(b.discountType) ? b.discountType : "PERCENT",
    status: "ACTIVE",
    usesLimit: ["UNLIMITED", "ONE_PER_CUSTOMER", "SINGLE"].includes(b.usesLimit) ? b.usesLimit : "UNLIMITED",
    repeatCustomerOnly: !!b.repeatCustomerOnly,
  };
  if (coupon.discountType !== "SHIPPING") coupon.discount = Number(b.discount || 0);
  if (b.launchDate) coupon.launchDate = `${b.launchDate} 00:00:00`;
  if (b.expirationDate) coupon.expirationDate = `${b.expirationDate} 23:59:59`;
  if (MOCK) {
    const c = { id: Date.now() % 100000, orderCount: 0, ...coupon };
    getMockCoupons().unshift(c);
    return { ok: true, coupon: c, mock: true };
  }
  const created = await ecwidWrite("POST", "/discount_coupons", coupon);
  return { ok: true, coupon: { id: created.id, ...coupon } };
}));

// ---- Abandoned carts + AI-drafted recovery emails ----
// Note: the Ecwid API exposes abandoned carts but cannot send email itself.
// This drafts the email (tone based on cart age + recovery status); Todd
// sends it via mailto/copy. Ecwid's own automatic recovery email is a store
// setting, separate from this.
function cartTier(daysOld) {
  if (daysOld < 2) return { tier: "New", tone: "a warm, friendly reminder — no discount, just helpfulness and a nudge that their items are waiting" };
  if (daysOld < 7) return { tier: "Warm", tone: "a helpful follow-up that sweetens the deal — mention the discount code if one is provided" };
  return { tier: "Cold", tone: "a last-chance note with gentle urgency — their cart may expire; lead with the discount code if one is provided" };
}

async function fetchAbandonedCarts() {
  if (MOCK) {
    const d = (days) => new Date(Date.now() - days * 86400000).toISOString();
    return [
      { cartId: "mock-a1", email: "amy@example.com", name: "Amy R.", total: 86.5, createDate: d(1), items: [{ name: "Bahama Mama Sausages (4-pack)", quantity: 2 }, { name: "Schmidt's Signature Mustard", quantity: 1 }] },
      { cartId: "mock-b2", email: "jake@example.com", name: "Jake T.", total: 145.0, createDate: d(4), items: [{ name: "Oktoberfest Party Platter", quantity: 1 }] },
      { cartId: "mock-c3", email: "maria@example.com", name: "", total: 29.0, createDate: d(9), items: [{ name: "Jumbo Cream Puff Kit", quantity: 1 }] },
    ];
  }
  if (!ECWID_API_TOKEN) throw new Error("ECWID_API_TOKEN not configured");
  const items = await ecwidPageAll("/abandoned_sales");
  return items.map((c) => ({
    cartId: c.cartId || c.id,
    email: c.email || c.customerEmail || "",
    name: [c.billingPerson?.name, c.shippingPerson?.name].find(Boolean) || "",
    total: c.total || c.cartValue || 0,
    createDate: c.createDate,
    items: (c.items || c.orderItems || []).map((i) => ({ name: i.name, quantity: i.quantity })),
  }));
}

app.get("/admin/api/abandoned", requireAdmin, safe(async () => {
  const carts = await fetchAbandonedCarts();
  const now = Date.now();
  return {
    carts: carts
      .map((c) => {
        const daysOld = Math.max(0, Math.floor((now - new Date(c.createDate)) / 86400000));
        return { ...c, daysOld, tier: cartTier(daysOld).tier };
      })
      .sort((a, b) => a.daysOld - b.daysOld),
    mock: MOCK,
  };
}));

async function buildRecoveryDraft(cart, couponCode) {
  const daysOld = Math.max(0, Math.floor((Date.now() - new Date(cart.createDate)) / 86400000));
  const { tier, tone } = cartTier(daysOld);
  const firstName = (cart.name || "").split(" ")[0] || "there";
  const itemList = (cart.items || []).map((i) => `${i.quantity}x ${i.name}`).join(", ");

  // Fallback template (used when OpenAI is unavailable)
  const fallback = () => {
    const codeLine = couponCode ? `\n\nUse code ${couponCode} at checkout for a little something extra on us.` : "";
    if (tier === "New") return {
      subject: "Your Schmidt's order is waiting for you",
      body: `Hi ${firstName},\n\nLooks like you left some goodies behind — ${itemList} are still in your cart at schmidthaus.com.\n\nYour cart is saved and ready whenever you are. If you hit a snag checking out, just reply and we'll help.${codeLine}\n\nDanke schön,\nSchmidt's Sausage Haus`,
    };
    if (tier === "Warm") return {
      subject: "Still thinking it over? Your Schmidt's cart is saved",
      body: `Hi ${firstName},\n\nYour cart with ${itemList} ($${cart.total.toFixed(2)}) is still saved at schmidthaus.com.${codeLine}\n\nOur Bahama Mamas don't stay on shelves long — finish your order while everything's still in stock.\n\nProst,\nSchmidt's Sausage Haus`,
    };
    return {
      subject: "Last call — your Schmidt's cart is about to expire",
      body: `Hi ${firstName},\n\nJust a heads-up: the cart you started at schmidthaus.com (${itemList}) will expire soon.${codeLine}\n\nIf you'd still like your order, now's the time — after that we can't guarantee the items or the price.\n\nWe'd love to get some Schmidt's on your table,\nSchmidt's Sausage Haus`,
    };
  };

  if (MOCK || !OPENAI_API_KEY) return { ...fallback(), tier, daysOld, generatedBy: "template" };

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.7,
        messages: [
          { role: "system", content: "You write short, warm cart-recovery emails for Schmidt's Sausage Haus (schmidthaus.com), a family-owned German restaurant and online store in Columbus, Ohio. Plain text only, no HTML, no placeholders like [Name]. Sign off as Schmidt's Sausage Haus. Respond ONLY with JSON: {\"subject\":\"\",\"body\":\"\"}." },
          { role: "user", content: `Write a cart recovery email.\nCustomer first name: ${firstName}\nCart items: ${itemList}\nCart value: $${cart.total.toFixed(2)}\nCart age: ${daysOld} day(s) — tone: ${tone}\n${couponCode ? `Discount code to include: ${couponCode}` : "No discount code — do not invent one."}\nKeep it under 130 words.` },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}`);
    const data = await resp.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    if (!parsed.subject || !parsed.body) throw new Error("bad JSON");
    return { subject: parsed.subject, body: parsed.body, tier, daysOld, generatedBy: OPENAI_MODEL };
  } catch (e) {
    console.error("Draft fallback:", e.message);
    return { ...fallback(), tier, daysOld, generatedBy: "template" };
  }
}

async function findCartOr404(cartId) {
  const carts = await fetchAbandonedCarts();
  const cart = carts.find((c) => String(c.cartId) === String(cartId));
  if (!cart) throw Object.assign(new Error("Cart not found."), { status: 404 });
  return cart;
}

app.post("/admin/api/abandoned/draft", requireAdmin, express.json(), safe(async (req) => {
  const { cartId, couponCode } = req.body || {};
  const cart = await findCartOr404(cartId);
  return buildRecoveryDraft(cart, couponCode);
}));

// ---- Send the recovery email through Smart 1 Suite (GHL) ----
// Upserts the contact, sends via the Conversations API, then tags the contact
// (cart-recovery-<cartId>-<tier>) so the same cart never gets the same-stage
// email twice. Requires PIT scopes: contacts.write + conversations/message.write.
const recoveryTag = (cartId, tier) =>
  `cart-recovery-${String(cartId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}-${tier.toLowerCase()}`;

async function sendRecoveryEmail(cart, subject, body, tier) {
  if (!cart.email) throw new Error("This cart has no email address.");
  if (MOCK) return { ok: true, mock: true, contactId: "mock-contact", tag: recoveryTag(cart.cartId, tier) };
  if (!GHL_PIT) throw new Error("GHL_PIT not configured");

  const [firstName, ...rest] = (cart.name || "").split(" ");
  const up = await ghlPost("/contacts/upsert", {
    locationId: GHL_LOCATION_ID,
    email: cart.email,
    ...(firstName ? { firstName, lastName: rest.join(" ") || undefined } : {}),
  });
  const contact = up.contact || up;
  const contactId = contact.id;
  if (!contactId) throw new Error("GHL did not return a contact id.");

  const tag = recoveryTag(cart.cartId, tier);
  const existingTags = (contact.tags || []).map((t) => String(t).toLowerCase());
  if (existingTags.includes(tag)) {
    return { ok: false, alreadySent: true, contactId, tag };
  }

  const html = String(body).split("\n").map((l) => l || "&nbsp;").join("<br>");
  await ghlPost("/conversations/messages", {
    type: "Email",
    contactId,
    subject,
    html,
    emailTo: cart.email,
  }, "2021-04-15");

  await ghlPost(`/contacts/${encodeURIComponent(contactId)}/tags`, { tags: [tag] }).catch((e) =>
    console.error("Tagging failed (email WAS sent):", e.message));

  return { ok: true, contactId, tag };
}

app.post("/admin/api/abandoned/send", requireAdmin, express.json(), safe(async (req) => {
  const { cartId, subject, body } = req.body || {};
  if (!subject || !body) throw Object.assign(new Error("Subject and body are required."), { status: 400 });
  const cart = await findCartOr404(cartId);
  const daysOld = Math.max(0, Math.floor((Date.now() - new Date(cart.createDate)) / 86400000));
  const { tier } = cartTier(daysOld);
  const result = await sendRecoveryEmail(cart, subject, body, tier);
  if (result.alreadySent) {
    return { ok: false, message: `A ${tier} recovery email was already sent for this cart — not sending again.` };
  }
  return { ok: true, message: `Email sent to ${cart.email} through Smart 1 Suite${result.mock ? " (sample mode — nothing actually sent)" : ""}.` };
}));

// ---- Fully automatic recovery (optional) ----
// AUTO_RECOVERY=true: every 6 hours, scan abandoned carts and send the
// stage-appropriate email for any cart that hasn't had that stage yet
// (deduped via contact tags, so restarts/redeploys can't double-send).
// AUTO_RECOVERY_COUPON optionally names a discount code to include in
// Warm/Cold emails. Carts older than 30 days are left alone.
const AUTO = String(AUTO_RECOVERY).toLowerCase() === "true";

async function autoRecoveryRun() {
  try {
    const carts = await fetchAbandonedCarts();
    let sent = 0, skipped = 0;
    for (const cart of carts) {
      if (!cart.email) continue;
      const daysOld = Math.max(0, Math.floor((Date.now() - new Date(cart.createDate)) / 86400000));
      if (daysOld > 30) continue;
      const { tier } = cartTier(daysOld);
      const coupon = tier === "New" ? "" : AUTO_RECOVERY_COUPON;
      try {
        const draft = await buildRecoveryDraft(cart, coupon || undefined);
        const result = await sendRecoveryEmail(cart, draft.subject, draft.body, tier);
        if (result.ok) { sent++; console.log(`Auto-recovery: sent ${tier} email to ${cart.email} (cart ${cart.cartId})`); }
        else skipped++;
      } catch (e) {
        console.error(`Auto-recovery failed for cart ${cart.cartId}: ${e.message}`);
      }
    }
    if (sent || skipped) console.log(`Auto-recovery run: ${sent} sent, ${skipped} already covered.`);
  } catch (e) {
    console.error("Auto-recovery run failed:", e.message);
  }
}

if (AUTO && !MOCK) {
  setTimeout(autoRecoveryRun, 60 * 1000);              // first pass 1 min after boot
  setInterval(autoRecoveryRun, 6 * 60 * 60 * 1000);    // then every 6 hours
}

app.get("/admin/api/recovery-status", requireAdmin, (req, res) =>
  res.json({ auto: AUTO, coupon: AUTO_RECOVERY_COUPON || null, mock: MOCK }));

// ---- Make a post image on request (each one costs OpenAI credits, so it
// only ever runs when someone clicks the button) ----
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const IMAGE_SIZES = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };

app.post("/api/social/image", requireAdmin, express.json(), safe(async (req) => {
  if (!OPENAI_API_KEY) throw Object.assign(new Error("OPENAI_API_KEY not configured."), { status: 503 });
  const b = req.body || {};
  const holiday = String(b.holiday || "").slice(0, 120);
  const idea = String(b.promoIdea || "").slice(0, 400);
  const post = String(b.samplePost || "").slice(0, 400);
  if (!holiday && !idea) throw Object.assign(new Error("Nothing to make a picture of."), { status: 400 });
  const size = IMAGE_SIZES[b.size] || IMAGE_SIZES.square;

  const prompt =
    `A warm, appetising social media photo for ${BRAND_NAME}, a lakeside winery in Thornville, Ohio ` +
    `with a tasting room, patio, live music and a food menu.\n` +
    `Occasion: ${holiday}\nWhat we're promoting: ${idea}\n` +
    `Style: natural daylight or golden-hour lakeside light, shallow depth of field, inviting and real — ` +
    `like a good phone photo from the patio, not a stock advert. Warm wood, wine glasses, greenery.\n` +
    `Important: no text, no words, no lettering, no logos, and no watermarks anywhere in the image. ` +
    `No people's faces in close-up.`;

  const call = async (model) => {
    const resp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, size, n: 1 }),
    });
    if (!resp.ok) {
      const err = new Error(`OpenAI images ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  };

  let data;
  try {
    data = await call(OPENAI_IMAGE_MODEL);
  } catch (e) {
    // gpt-image-1 needs a verified OpenAI org; fall back to DALL·E 3 so the
    // button still works on accounts that haven't done that.
    if (OPENAI_IMAGE_MODEL === "gpt-image-1") {
      const dalleSize = size === "1024x1536" ? "1024x1792" : size === "1536x1024" ? "1792x1024" : "1024x1024";
      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "dall-e-3", prompt, size: dalleSize, n: 1, response_format: "b64_json" }),
      });
      if (!resp.ok) throw new Error(`Image generation failed: ${(await resp.text()).slice(0, 200)}`);
      data = await resp.json();
      data.model = "dall-e-3";
    } else throw e;
  }

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("The image service didn't return a picture.");
  return { image: `data:image/png;base64,${b64}`, model: data.model || OPENAI_IMAGE_MODEL, size };
}));

// ================================================================ ROUTES
app.get("/health", (req, res) =>
  res.json({ status: "ok", mock: MOCK, timestamp: new Date().toISOString() })
);

app.get("/api/config", (req, res) =>
  res.json({
    brand: BRAND_NAME,
    site: SITE_URL,
    promoFormUrl: PROMO_FORM_URL,
    adminEnabled: !!ADMIN_PASSWORD,
    signedIn: !!ADMIN_PASSWORD && isAdminRequest(req),
    mock: MOCK,
  })
);

app.get("/api/ecwid", safe(() => getEcwidData()));
app.get("/api/promotions", safe(() => getPromotions()));
app.get("/api/leads", safe(() => getLeads()));
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
  const [ecwid, promotions, analytics, social, leads] = await Promise.all([
    getEcwidData().catch((e) => ({ error: e.message })),
    getPromotions().catch((e) => ({ error: e.message })),
    getAnalytics().catch((e) => ({ error: e.message })),
    getSocialSuggestions().catch((e) => ({ error: e.message, suggestions: [] })),
    getLeads().catch((e) => ({ error: e.message })),
  ]);
  return {
    ecwid, promotions, analytics, social, leads,
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
