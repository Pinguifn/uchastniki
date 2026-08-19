import {createServer} from 'node:http';
import {readFileSync, existsSync, mkdirSync} from 'node:fs';
import {extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isIP} from 'node:net';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const RATE_CLEANUP_MS = 5 * 60 * 1000;
const OUTBOX_MAX_ATTEMPTS = Math.max(1, Number(process.env.OUTBOX_MAX_ATTEMPTS || 8));
const OUTBOX_SENT_RETENTION_DAYS = Math.max(1, Number(process.env.OUTBOX_SENT_RETENTION_DAYS || 7));
const OUTBOX_FAILED_RETENTION_DAYS = Math.max(1, Number(process.env.OUTBOX_FAILED_RETENTION_DAYS || 30));
const APPLICATION_RETENTION_DAYS = Math.max(1, Number(process.env.APPLICATION_RETENTION_DAYS || 365));
const PERSISTENT_CLEANUP_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_API_BASE = String(process.env.TELEGRAM_API_BASE || ('https:' + '//' + 'api.telegram.org')).replace(/\/+$/, '');
const TELEGRAM_RELAY_URL = String(process.env.TELEGRAM_RELAY_URL || '').trim().replace(/\/+$/, '');
const TELEGRAM_RELAY_SECRET = String(process.env.TELEGRAM_RELAY_SECRET || '').trim();
const TELEGRAM_TIME_ZONE = String(process.env.TELEGRAM_TIME_ZONE || 'Asia/Yekaterinburg').trim();
const telegramPollInput = Number(process.env.TELEGRAM_POLL_MS || 15000);
const TELEGRAM_POLL_MS = Number.isFinite(telegramPollInput) ? Math.max(1000, telegramPollInput) : 15000;
const TELEGRAM_DIRECT_CONFIGURED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const TELEGRAM_RELAY_CONFIGURED = (() => {
  if (!TELEGRAM_RELAY_URL || TELEGRAM_RELAY_SECRET.length < 32) return false;
  try {
    const endpoint = new URL(TELEGRAM_RELAY_URL);
    const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost';
    return endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback);
  } catch {
    return false;
  }
})();
const TELEGRAM_CONFIGURED = TELEGRAM_RELAY_CONFIGURED || TELEGRAM_DIRECT_CONFIGURED;
const TELEGRAM_MODE = TELEGRAM_RELAY_CONFIGURED ? 'relay' : TELEGRAM_DIRECT_CONFIGURED ? 'direct' : 'disabled';


mkdirSync(DATA_DIR, {recursive: true, mode: 0o750});
const db = new DatabaseSync(join(DATA_DIR, 'applications.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS membership_applications (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    telegram TEXT NOT NULL,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    consent INTEGER NOT NULL CHECK (consent = 1)
  );
  CREATE INDEX IF NOT EXISTS idx_membership_applications_created_at ON membership_applications(created_at DESC);
  CREATE TABLE IF NOT EXISTS telegram_outbox (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    application_type TEXT NOT NULL CHECK (application_type = 'membership'),
    message TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    sent_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_telegram_outbox_pending
    ON telegram_outbox(sent_at, next_attempt_at, created_at);
`);
db.prepare(`DELETE FROM telegram_outbox WHERE application_type <> 'membership'`).run();
const insertMembershipApplication = db.prepare(`
  INSERT INTO membership_applications
  (id, created_at, full_name, phone, email, telegram, company, role, consent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
`);
const insertTelegramOutbox = db.prepare(`
  INSERT INTO telegram_outbox
  (id, application_id, application_type, message, attempts, next_attempt_at, created_at)
  VALUES (?, ?, ?, ?, 0, ?, ?)
`);
const selectTelegramOutbox = db.prepare(`
  SELECT id, application_id, application_type, message, attempts
  FROM telegram_outbox
  WHERE application_type = 'membership' AND sent_at IS NULL AND next_attempt_at <= ? AND attempts < ?
  ORDER BY created_at ASC
  LIMIT 10
`);
const markTelegramSent = db.prepare(`
  UPDATE telegram_outbox
  SET sent_at = ?, last_error = NULL
  WHERE id = ?
`);
const markTelegramFailed = db.prepare(`
  UPDATE telegram_outbox
  SET attempts = ?, next_attempt_at = ?, last_error = ?
  WHERE id = ?
`);
const deleteSentTelegramOutbox = db.prepare(`
  DELETE FROM telegram_outbox
  WHERE sent_at IS NOT NULL AND sent_at < ?
`);
const deleteFailedTelegramOutbox = db.prepare(`
  DELETE FROM telegram_outbox
  WHERE sent_at IS NULL AND attempts >= ? AND created_at < ?
`);
const deleteExpiredMembershipApplications = db.prepare(`
  DELETE FROM membership_applications
  WHERE created_at < ?
`);

const staticRoutes = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/404.html', '404.html'],
  ['/robots.txt', 'robots.txt'],
  ['/sitemap.xml', 'sitemap.xml'],
  ['/og-image.png', 'og-image.png'],
  ['/cookie-notice.css', 'cookie-notice.css'],
  ['/cookie-notice.js', 'cookie-notice.js'],
  ['/soglasie-na-obrabotku-personalnyh-dannyh.html', 'soglasie-na-obrabotku-personalnyh-dannyh.html'],
  ['/politika-konfidencialnosti.html', 'politika-konfidencialnosti.html'],
  ['/politika-cookie.html', 'politika-cookie.html'],
  ['/dogovor-oferty.html', 'dogovor-oferty.html'],
  ['/politika-obrabotki-personalnyh-dannyh.html', 'politika-obrabotki-personalnyh-dannyh.html']
]);
const mimeTypes = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8','.png':'image/png'};
const limits = new Map();

function securityHeaders() {
  const csp = "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-src https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {...securityHeaders(), 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'Content-Length':Buffer.byteLength(body)});
  res.end(body);
}

function normalizeIp(value) {
  let candidate = String(value || '').trim();
  if (candidate.startsWith('[') && candidate.includes(']')) candidate = candidate.slice(1, candidate.indexOf(']'));
  if (candidate.startsWith('::ffff:')) candidate = candidate.slice(7);
  return isIP(candidate) ? candidate : '';
}

function requestKey(req) {
  const remoteAddress = normalizeIp(req.socket.remoteAddress) || 'unknown';
  const isLocalProxy = remoteAddress === '127.0.0.1' || remoteAddress === '::1';
  if (isLocalProxy) {
    const realIp = normalizeIp(req.headers['x-real-ip']);
    if (realIp) return realIp;
  }
  return remoteAddress;
}

function isRateLimited(key) {
  const now = Date.now();
  const state = limits.get(key);
  if (!state || state.resetAt <= now) {
    limits.set(key, {count: 1, resetAt: now + RATE_WINDOW_MS});
    return false;
  }
  if (state.count >= RATE_MAX) return true;
  state.count += 1;
  return false;
}

function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, state] of limits) {
    if (state.resetAt <= now) limits.delete(key);
  }
}

function originIsAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGIN) return origin.replace(/\/$/, '') === ALLOWED_ORIGIN;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('too_large'), {status:413})); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('invalid_json'), {status:400})); }
    });
    req.on('error', reject);
  });
}

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const escapeTelegramHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function formatTelegramDate(isoDate) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: TELEGRAM_TIME_ZONE,
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(isoDate));
  } catch {
    return isoDate;
  }
}

function buildTelegramMessage(_values, createdAt) {
  return [
    '🤝 <b>Поступила новая заявка «Стать участником»</b>',
    '',
    `<b>Дата:</b> ${escapeTelegramHtml(formatTelegramDate(createdAt))}`,
    'Персональные данные сохранены только в базе на сервере и не переданы в это уведомление.',
    'Для просмотра выполните защищённый экспорт заявок на сервере.'
  ].join('\n').slice(0, 4096);
}

function queueTelegramNotification(applicationId, values, createdAt) {
  const message = buildTelegramMessage(values, createdAt);
  insertTelegramOutbox.run(randomUUID(), applicationId, 'membership', message, createdAt, createdAt);
}

function nextTelegramAttempt(attempts) {
  const delays = [15, 60, 300, 900, 3600, 21600];
  const delaySeconds = delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)];
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

async function sendTelegramMessage(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const relayMode = TELEGRAM_RELAY_CONFIGURED;
  const endpoint = relayMode
    ? TELEGRAM_RELAY_URL
    : `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const headers = {'Content-Type':'application/json; charset=utf-8'};
  if (relayMode) headers.Authorization = `Bearer ${TELEGRAM_RELAY_SECRET}`;
  const body = relayMode
    ? {text: message}
    : {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      };
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      const description = clean(payload.description || payload.message || `HTTP ${response.status}`, 300);
      throw new Error(description || 'Telegram delivery error');
    }
  } finally {
    clearTimeout(timeout);
  }
}

let telegramFlushRunning = false;
async function flushTelegramOutbox() {
  if (!TELEGRAM_CONFIGURED || telegramFlushRunning) return;
  telegramFlushRunning = true;
  try {
    const pending = selectTelegramOutbox.all(new Date().toISOString(), OUTBOX_MAX_ATTEMPTS);
    for (const item of pending) {
      try {
        await sendTelegramMessage(item.message);
        markTelegramSent.run(new Date().toISOString(), item.id);
        console.log(JSON.stringify({event:'telegram_notification_sent', applicationId:item.application_id, applicationType:item.application_type}));
      } catch (error) {
        const attempts = Number(item.attempts || 0) + 1;
        const message = clean(error?.message || 'Telegram delivery failed', 500);
        markTelegramFailed.run(attempts, nextTelegramAttempt(attempts), message, item.id);
        console.error(JSON.stringify({event:'telegram_notification_failed', applicationId:item.application_id, applicationType:item.application_type, attempts, error:message}));
      }
    }
  } finally {
    telegramFlushRunning = false;
  }
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function cleanupPersistentData() {
  const sent = deleteSentTelegramOutbox.run(isoDaysAgo(OUTBOX_SENT_RETENTION_DAYS));
  const failed = deleteFailedTelegramOutbox.run(OUTBOX_MAX_ATTEMPTS, isoDaysAgo(OUTBOX_FAILED_RETENTION_DAYS));
  const applications = deleteExpiredMembershipApplications.run(isoDaysAgo(APPLICATION_RETENTION_DAYS));
  const deleted = Number(sent.changes || 0) + Number(failed.changes || 0) + Number(applications.changes || 0);
  if (deleted > 0) {
    console.log(JSON.stringify({
      event: 'data_retention_cleanup',
      sentOutboxDeleted: Number(sent.changes || 0),
      failedOutboxDeleted: Number(failed.changes || 0),
      applicationsDeleted: Number(applications.changes || 0)
    }));
  }
}

function validateMembership(input) {
  const values = {
    fullName: clean(input.fullName, 120),
    phone: clean(input.phone, 24),
    email: clean(input.email, 254).toLowerCase(),
    telegram: clean(input.telegram, 64),
    company: clean(input.company, 120),
    role: clean(input.role, 120),
    consent: input.consent === true
  };
  const errors = {};
  if (values.fullName.length < 3) errors.fullName = 'Укажите ФИО.';
  const digits = values.phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) errors.phone = 'Проверьте номер телефона.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Проверьте Email.';
  if (!/^(@[A-Za-z0-9_]{5,32}|https?:\/\/(t\.me|telegram\.me)\/[A-Za-z0-9_]{5,32})$/i.test(values.telegram)) errors.telegram = 'Укажите @username или ссылку Telegram.';
  if (values.company.length < 2) errors.company = 'Укажите компанию.';
  if (values.role.length < 2) errors.role = 'Укажите роль в компании.';
  if (!values.consent) errors.consent = 'Необходимо согласие на обработку данных.';
  return {values, errors};
}

async function handleMembershipApplication(req, res) {
  if (!originIsAllowed(req)) return sendJson(res, 403, {message:'Запрос отклонён.'});
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(res, 415, {message:'Ожидается JSON.'});
  const key = 'membership:' + requestKey(req);
  if (isRateLimited(key)) return sendJson(res, 429, {message:'Слишком много попыток. Попробуйте через 10 минут.'});
  try {
    const input = await readJson(req);
    if (clean(input.website, 200)) return sendJson(res, 200, {ok:true});
    const {values, errors} = validateMembership(input);
    if (Object.keys(errors).length) return sendJson(res, 422, {message:'Проверьте заполнение анкеты.', fields:errors});
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      insertMembershipApplication.run(id, createdAt, values.fullName, values.phone, values.email, values.telegram, values.company, values.role);
      queueTelegramNotification(id, values, createdAt);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    console.log(JSON.stringify({event:'membership_application_created', id, at:createdAt}));
    void flushTelegramOutbox();
    return sendJson(res, 201, {ok:true, id});
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return sendJson(res, status, {message:status === 413 ? 'Анкета слишком большая.' : status === 400 ? 'Некорректный запрос.' : 'Сервер временно недоступен.'});
  }
}

function serveStatic(req, res, pathname) {
  const fileName = staticRoutes.get(pathname);
  if (!fileName) return false;
  const filePath = resolve(ROOT, fileName);
  if (!filePath.startsWith(resolve(ROOT)) || !existsSync(filePath)) return false;
  const body = readFileSync(filePath);
  const cache = /\.(?:css|js|png)$/.test(fileName) ? 'public, max-age=86400' : 'no-cache';
  res.writeHead(200, {...securityHeaders(), 'Content-Type':mimeTypes[extname(fileName)] || 'application/octet-stream', 'Cache-Control':cache, 'Content-Length':body.length});
  if (req.method === 'HEAD') res.end(); else res.end(body);
  return true;
}

const server = createServer(async (req, res) => {
  req.setTimeout(12000);
  let pathname;
  try { pathname = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname; }
  catch { return sendJson(res, 400, {message:'Некорректный адрес.'}); }

  if (req.method === 'POST' && pathname === '/api/membership-applications') return handleMembershipApplication(req, res);
  if (req.method === 'GET' && pathname === '/healthz') return sendJson(res, 200, {ok:true, telegramConfigured:TELEGRAM_CONFIGURED, telegramMode:TELEGRAM_MODE});
  if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, pathname)) return;

  const fallback = readFileSync(join(ROOT, '404.html'));
  res.writeHead(404, {...securityHeaders(), 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache', 'Content-Length':fallback.length});
  res.end(fallback);
});

const telegramTimer = setInterval(() => void flushTelegramOutbox(), TELEGRAM_POLL_MS);
const rateCleanupTimer = setInterval(cleanupRateLimits, RATE_CLEANUP_MS);
const persistentCleanupTimer = setInterval(cleanupPersistentData, PERSISTENT_CLEANUP_MS);
telegramTimer.unref();
rateCleanupTimer.unref();
persistentCleanupTimer.unref();
cleanupPersistentData();
if (TELEGRAM_CONFIGURED) {
  db.prepare(`UPDATE telegram_outbox SET next_attempt_at = ? WHERE sent_at IS NULL`).run(new Date().toISOString());
  console.log(JSON.stringify({event:'telegram_delivery_configured', mode:TELEGRAM_MODE}));
  setTimeout(() => void flushTelegramOutbox(), 250).unref();
} else {
  console.warn('Telegram notifications are disabled: configure a relay or direct Telegram credentials.');
}

server.listen(PORT, HOST, () => console.log('UCHASTNIKI server listening on http://' + HOST + ':' + PORT));
function shutdown() {
  clearInterval(telegramTimer);
  clearInterval(rateCleanupTimer);
  clearInterval(persistentCleanupTimer);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
