// ============================================================================
// AVTOMATIK YARATILGAN: vercel-bot-setup.mjs tomonidan (polling -> webhook).
// Qayta yaratish: node vercel-bot-setup.mjs --force
// Env: BOT_TOKEN (bot kodingiz ishlatadigani), WEBHOOK_SECRET (ixtiyoriy),
//      DB_POOL_MAX (default 3), DB_POOL_IDLE_MS (default 5000)
// ============================================================================

if (typeof process.getBuiltinModule !== 'function') {
  throw new Error('Node 22.x kerak. package.json da: "engines": { "node": "22.x" }');
}
const http = process.getBuiltinModule('node:http');
const https = process.getBuiltinModule('node:https');
const net = process.getBuiltinModule('node:net');
const Module = process.getBuiltinModule('node:module');

process.env.VERCEL_SERVERLESS = '1';
const POOL_MAX = parseInt(process.env.DB_POOL_MAX || '3', 10);
const IDLE_MS = parseInt(process.env.DB_POOL_IDLE_MS || '5000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- bot ro'yxati va kuzatuv (NTBA uchun) --------------------------------- */
const bots = [];
function capture(kind, bot, initFn) {
  if (bots.some((b) => b.bot === bot)) return;
  const entry = { kind, bot, init: null };
  entry.init = Promise.resolve()
    .then(() => initFn && initFn())
    .catch((e) => console.error('[bot init]', e && e.message ? e.message : e));
  bots.push(entry);
}

const tracked = new Set();
let inflight = 0;
function track(p) {
  if (p && typeof p.then === 'function') {
    tracked.add(p);
    const done = () => tracked.delete(p);
    p.then(done, (e) => { done(); console.error('[bot handler]', e); });
  }
  return p;
}
async function settle(maxMs) {
  const t = Date.now();
  await sleep(20);
  while ((tracked.size > 0 || inflight > 0) && Date.now() - t < maxMs) await sleep(20);
  await sleep(30);
}

/* ---- 1) Telegram deleteWebhook'ni bloklash (webhook'ni o'chirmasin) -------- */
const noDelete = (s) => String(s).replace(/(api\.telegram\.org\/bot[^/]+)\/deleteWebhook/i, '$1/getMe');
const origHttpsRequest = https.request;
https.request = function () {
  const args = Array.from(arguments);
  try {
    const a = args[0];
    if (typeof a === 'string') args[0] = noDelete(a);
    else if (a instanceof URL) args[0] = new URL(noDelete(a.href));
    else if (a && typeof a === 'object' && /api\.telegram\.org/.test(a.hostname || a.host || '') && typeof a.path === 'string') {
      a.path = a.path.replace(/\/deleteWebhook(\?|$)/i, '/getMe$1');
    }
  } catch (_) {}
  return origHttpsRequest.apply(this, args);
};
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (u, ...r) {
    try {
      if (typeof u === 'string') u = noDelete(u);
      else if (u instanceof URL) u = new URL(noDelete(u.href));
    } catch (_) {}
    return origFetch.call(this, u, ...r);
  };
}

/* ---- 2) listen() ni ushlab olish (bot bilan birga express bo'lsa) ---------- */
let capturedServer = null;
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) {
  if (this.listenerCount('request') > 0) {
    capturedServer = this;
    this.address = () => ({ address: '0.0.0.0', family: 'IPv4', port: 0 });
    const cb = a.find((x) => typeof x === 'function');
    if (cb) this.once('listening', cb);
    process.nextTick(() => this.emit('listening'));
    return this;
  }
  return origListen.apply(this, a);
};

/* ---- 3) Kutubxonalarni moslash (polling o'chiriladi) ----------------------- */
let attachPool = () => {};
// @vercel/functions o'rnatilmagan — attachDatabasePool o'chirilgan

const patched = new WeakSet();
const WATCH = /(^|[\\/])(grammy|telegraf|node-telegram-bot-api|pg|mysql2)([\\/]|$)/;

function patchLib(exp) {
  if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) return;
  if (patched.has(exp)) return;

  // ---- grammY
  const Bot = exp.Bot;
  if (typeof Bot === 'function' && Bot.prototype && typeof Bot.prototype.start === 'function' &&
      typeof Bot.prototype.handleUpdate === 'function') {
    patched.add(exp);
    Bot.prototype.start = async function (o) {
      capture('grammy', this, () => this.init());
      if (o && typeof o.onStart === 'function') { try { o.onStart(this.botInfo); } catch (_) {} }
    };
    return;
  }

  // ---- Telegraf
  const Tf = exp.Telegraf;
  if (typeof Tf === 'function' && Tf.prototype && typeof Tf.prototype.launch === 'function' &&
      typeof Tf.prototype.handleUpdate === 'function') {
    patched.add(exp);
    Tf.prototype.launch = async function (_cfg, onLaunch) {
      capture('telegraf', this, async () => {
        if (!this.botInfo) this.botInfo = await this.telegram.getMe();
      });
      if (typeof onLaunch === 'function') { try { onLaunch(); } catch (_) {} }
    };
    return;
  }

  // ---- node-telegram-bot-api
  const T = typeof exp === 'function' && exp.prototype && typeof exp.prototype.startPolling === 'function' &&
    typeof exp.prototype.processUpdate === 'function' ? exp
    : (exp.default && typeof exp.default === 'function' && exp.default.prototype &&
       typeof exp.default.prototype.startPolling === 'function' ? exp.default : null);
  if (T) {
    patched.add(exp);
    const P = T.prototype;
    P.startPolling = function () { capture('ntba', this); return Promise.resolve(); };
    P.stopPolling = function () { return Promise.resolve(); };
    const wrapFn = (fn) => (typeof fn !== 'function' ? fn : function (...a) { return track(fn.apply(this, a)); });
    for (const m of ['on', 'addListener', 'once']) {
      const o = P[m];
      P[m] = function (ev, fn) { return o.call(this, ev, wrapFn(fn)); };
    }
    const oText = P.onText;
    P.onText = function (re, cb) { return oText.call(this, re, wrapFn(cb)); };
    const oReq = P._request;
    if (typeof oReq === 'function') {
      P._request = function () {
        inflight++;
        let p;
        try { p = oReq.apply(this, arguments); } catch (e) { inflight--; throw e; }
        return Promise.resolve(p).finally(() => { inflight--; });
      };
    }
    return;
  }

  // ---- pg
  if (exp.Pool && exp.Client && typeof exp.Pool === 'function' && exp.defaults) {
    patched.add(exp);
    const Orig = exp.Pool;
    class VercelPool extends Orig {
      constructor(cfg, ...rest) {
        const c = typeof cfg === 'string' ? { connectionString: cfg } : Object.assign({}, cfg || {});
        c.max = Math.min(c.max || POOL_MAX, POOL_MAX);
        if (c.idleTimeoutMillis === undefined) c.idleTimeoutMillis = IDLE_MS;
        super(c, ...rest);
        attachPool(this);
      }
    }
    exp.Pool = VercelPool;
    return;
  }

  // ---- mysql2
  if (typeof exp.createPool === 'function' && typeof exp.createConnection === 'function') {
    patched.add(exp);
    const orig = exp.createPool;
    try {
      exp.createPool = function (cfg, ...rest) {
        if (cfg && typeof cfg === 'object') {
          cfg = Object.assign({}, cfg, { connectionLimit: Math.min(cfg.connectionLimit || POOL_MAX, POOL_MAX) });
        }
        const pool = orig.call(this, cfg, ...rest);
        attachPool(pool);
        return pool;
      };
    } catch (_) {}
  }
}

const origLoad = Module._load;
Module._load = function (request) {
  const exp = origLoad.apply(this, arguments);
  try { if (WATCH.test(String(request))) patchLib(exp); } catch (_) {}
  return exp;
};

/* ---- 4) Botni yuklash ------------------------------------------------------ */
let ready = null;
async function bootstrap() {
  await import('../index.js');
  for (let i = 0; i < 150 && bots.length === 0; i++) await sleep(100);
  if (bots.length === 0) {
    throw new Error(
      'Bot topilmadi: entry faylda bot.start() / bot.launch() / { polling: true } chaqirilishi kerak ' +
      '(grammy, telegraf yoki node-telegram-bot-api).'
    );
  }
  await Promise.all(bots.map((b) => b.init));
}

async function dispatch(b, update) {
  if (b.kind === 'ntba') {
    b.bot.processUpdate(update);
    await settle(25000);
  } else {
    await b.bot.handleUpdate(update);
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function send(res, code, obj) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

export default async function handler(req, res) {
  try {
    if (!ready) ready = bootstrap();
    await ready;
  } catch (err) {
    ready = null; // Telegram qayta yuboradi, yangilanish yo'qolmaydi
    console.error('[vercel-bot] ishga tushmadi:', err);
    return send(res, 500, { ok: false, error: 'bootstrap failed' });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body && typeof body.update_id === 'number') {
      const secret = process.env.WEBHOOK_SECRET;
      if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
        return send(res, 403, { ok: false, error: 'forbidden' });
      }
      let i = 0;
      try { i = parseInt(new URL(req.url, 'http://x').searchParams.get('i') || '0', 10) || 0; } catch (_) {}
      const b = bots[Math.min(i, bots.length - 1)];
      try {
        await dispatch(b, body);
      } catch (e) {
        // 200 qaytaramiz: aks holda Telegram shu yangilanishni cheksiz qayta yuboradi
        console.error('[bot] yangilanishni qayta ishlashda xato:', e);
      }
      return send(res, 200, { ok: true });
    }
    if (body) { req._body = true; req.body = body; }
  }

  if (capturedServer) return capturedServer.emit('request', req, res);
  return send(res, 200, { ok: true, mode: 'webhook', bots: bots.length });
}
