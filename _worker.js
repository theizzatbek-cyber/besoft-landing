// Джефф — Telegram-бот на Cloudflare: задачи в Notion, дедлайны, намазы, истигфар.
// Работает внутри Cloudflare Pages (_worker.js) по адресам /jeff/*; остальной сайт отдаётся как есть.
// Привязки: DB (D1). Секреты: TELEGRAM_TOKEN, LLM_API_KEY, NOTION_TOKEN.
// Расписание: отдельный маленький Worker раз в минуту вызывает /jeff/cron.

const TZ_MIN = 300; // Asia/Tashkent, UTC+5, без перевода часов
const LLM_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const LLM_MODELS = ['gemini-3.5-flash', 'gemini-flash-lite-latest'];
const LLM_TIMEOUT_MS = 12000;
const MORNING = '09:00', EVENING = '21:00';
const REMIND_BEFORE_MIN = 60;
const PING_EVERY_SEC = 600; // напоминание о намазе каждые 10 минут
const SAJDA_GEONAME = 1512569; // Ташкент
const SAJDA_METHOD = 46; // ДУМ УЗ
const PROJECTS = ['Newton', 'Be Soft'];
const PRAYERS = [
  { key: 'bomdod', name: 'Бомдод' }, { key: 'peshin', name: 'Пешин' }, { key: 'asr', name: 'Аср' },
  { key: 'shom', name: 'Шом' }, { key: 'xufton', name: 'Хуфтон' }, { key: 'vitr', name: 'Витр' },
];
const VITR_AFTER_MIN = 20; // Витр напоминаем через 20 минут после Хуфтон
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// Notion: названия колонок базы. Если переименуешь колонку в Notion — поменяй и здесь.
const NOTION_VERSION = '2025-09-03';
const NOTION_DB_TITLE = 'Задачи Джеффа';
const P = { title: 'Задача', status: 'Статус', project: 'Проект', deadline: 'Дедлайн', created: 'Поставлена', step: 'Следующий шаг' };
const STATUS_OPTIONS = [
  { name: 'Новые', color: 'blue' }, { name: 'В работе', color: 'yellow' },
  { name: 'На проверке', color: 'purple' }, { name: 'Готово', color: 'green' },
];
const DONE_RE = /готов|выполн|сделан|закрыт|done/i;

// ---------- Время ----------
const pad = (n) => String(n).padStart(2, '0');
function nowLocal(ts = Date.now()) { return new Date(ts + TZ_MIN * 60000).toISOString().slice(0, 16); } // YYYY-MM-DDTHH:MM
function today(ts) { return nowLocal(ts).slice(0, 10); }
function addMin(hhmm, n) { const [h, m] = hhmm.split(':').map(Number); const t = Math.min(h * 60 + m + n, 23 * 60 + 59); return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }
function parseDt(v) {
  if (!v || typeof v !== 'string') return '';
  v = v.trim().replace(' ', 'T');
  let m = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (m && !isNaN(Date.parse(m[1] + 'T' + m[2] + ':00Z'))) return m[1] + 'T' + m[2];
  m = v.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (m && !isNaN(Date.parse(m[1] + 'T00:00:00Z'))) return m[1] + 'T18:00';
  return '';
}
const localToIso = (local) => local + ':00+05:00';
function notionDateToLocal(s) { // дата без времени считается до 18:00
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T18:00';
  const ts = Date.parse(s);
  return isNaN(ts) ? '' : nowLocal(ts);
}
function human(local) {
  if (!local) return 'без дедлайна';
  const d = new Date(local + ':00Z');
  return `${WEEKDAYS[d.getUTCDay()]}, ${local.slice(8, 10)}.${local.slice(5, 7)}.${local.slice(0, 4)} ${local.slice(11, 16)}`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// ---------- База (D1) ----------
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  // старые задачи из D1 — переносятся в Notion при подключении и удаляются отсюда
  `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, project TEXT, next_step TEXT,
    deadline TEXT, created TEXT NOT NULL, status TEXT NOT NULL, pos REAL NOT NULL DEFAULT 0, reminded INTEGER NOT NULL DEFAULT 0, done_at TEXT)`,
  'CREATE TABLE IF NOT EXISTS nums (num INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT NOT NULL UNIQUE)',
  'CREATE TABLE IF NOT EXISTS nrem (page TEXT PRIMARY KEY, deadline TEXT NOT NULL, stage INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS pings (date TEXT NOT NULL, key TEXT NOT NULL, last INTEGER NOT NULL, msg INTEGER, PRIMARY KEY (date, key))',
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  schemaReady = true;
}
async function getMeta(env, k, fallback = null) {
  const r = await env.DB.prepare('SELECT v FROM meta WHERE k=?').bind(k).first();
  if (!r) return fallback;
  try { return JSON.parse(r.v); } catch { return fallback; }
}
async function setMeta(env, k, v) {
  await env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, JSON.stringify(v)).run();
}
async function getDay(env, date) {
  const r = await env.DB.prepare('SELECT data FROM days WHERE date=?').bind(date).first();
  let d = {};
  if (r) { try { d = JSON.parse(r.data) || {}; } catch { d = {}; } }
  return { prayers: d.prayers || {}, istighfar: Number(d.istighfar) || 0, vakia: !!d.vakia };
}
async function saveDay(env, date, d) {
  await env.DB.prepare('INSERT INTO days (date, data) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET data=excluded.data').bind(date, JSON.stringify(d)).run();
}
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));

// ---------- Telegram ----------
async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const j = await r.json();
    if (!j.ok) console.log('tg error', method, j.description);
    return j;
  } catch (e) { console.log('tg failed', method, String(e)); return { ok: false }; }
}
const send = (env, chat, text, extra) => tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) });
async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const webhookSecret = async (env) => (await sha256hex('webhook:' + env.TELEGRAM_TOKEN)).slice(0, 48);

// ---------- Notion ----------
class NotionSetupError extends Error {}
async function notion(env, method, path, body, retry = true) {
  if (!env.NOTION_TOKEN) throw new NotionSetupError('Notion не подключён: нет ключа NOTION_TOKEN в настройках Cloudflare.');
  const r = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + env.NOTION_TOKEN, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  if (r.status === 429 && retry) {
    await new Promise((res) => setTimeout(res, Math.min(5, Number(r.headers.get('Retry-After')) || 1) * 1000));
    return notion(env, method, path, body, false);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`Notion ${r.status}: ${j.message || 'ошибка'}`);
    err.status = r.status;
    if (r.status === 401) throw new NotionSetupError('Notion не принял ключ NOTION_TOKEN — проверь его в настройках Cloudflare.');
    throw err;
  }
  return j;
}
const plain = (arr) => (Array.isArray(arr) ? arr.map((t) => t.plain_text || (t.text && t.text.content) || '').join('') : '');
const richText = (s) => [{ type: 'text', text: { content: String(s).slice(0, 1900) } }];

// Подключение: находит страницу, к которой открыт доступ интеграции, и создаёт в ней базу задач
async function ensureNotion(env) {
  const saved = await getMeta(env, 'notion');
  if (saved && saved.ds) return saved;
  if (env.NOTION_DATA_SOURCE) {
    const cfg = { ds: env.NOTION_DATA_SOURCE, url: env.NOTION_URL || '' };
    await setMeta(env, 'notion', cfg);
    return cfg;
  }
  if (!env.NOTION_TOKEN) throw new NotionSetupError('Notion не подключён: нет ключа NOTION_TOKEN в настройках Cloudflare.');
  const found = await notion(env, 'POST', '/search', { filter: { property: 'object', value: 'page' }, page_size: 25 });
  const parent = (found.results || []).find((p) => p.object === 'page' && !p.in_trash && !p.archived && p.parent &&
    p.parent.type !== 'data_source_id' && p.parent.type !== 'database_id');
  if (!parent) throw new NotionSetupError('Notion подключён, но Джеффу не открыта ни одна страница. В Notion открой страницу → ••• → «Подключения» → добавь «Джефф».');
  const db = await notion(env, 'POST', '/databases', {
    parent: { type: 'page_id', page_id: parent.id },
    title: richText(NOTION_DB_TITLE),
    icon: { type: 'emoji', emoji: '✅' },
    initial_data_source: {
      properties: {
        [P.title]: { title: {} },
        [P.status]: { select: { options: STATUS_OPTIONS } },
        [P.project]: { select: { options: [{ name: 'Newton', color: 'purple' }, { name: 'Be Soft', color: 'green' }] } },
        [P.deadline]: { date: {} },
        [P.created]: { created_time: {} },
        [P.step]: { rich_text: {} },
      },
    },
  });
  let ds = db.data_sources && db.data_sources[0] && db.data_sources[0].id;
  if (!ds) {
    const full = await notion(env, 'GET', '/databases/' + db.id);
    ds = full.data_sources && full.data_sources[0] && full.data_sources[0].id;
  }
  if (!ds) throw new Error('Notion создал базу, но не вернул её источник данных.');
  const cfg = { db: db.id, ds, url: db.url || '' };
  await setMeta(env, 'notion', cfg);
  await importOldTasks(env, cfg);
  return cfg;
}
// Схема базы: какие статусы есть и какого типа колонка статуса (select или status)
async function notionSchema(env, cfg, force = false) {
  const cached = await getMeta(env, 'nschema');
  if (!force && cached && cached.ds === cfg.ds && Date.now() - cached.at < 10 * 60e3) return cached;
  const src = await notion(env, 'GET', '/data_sources/' + cfg.ds);
  const sp = (src.properties || {})[P.status] || {};
  const statusType = sp.type === 'status' ? 'status' : 'select';
  const statuses = ((sp[statusType] || {}).options || []).map((o) => o.name).filter(Boolean);
  const schema = { ds: cfg.ds, at: Date.now(), statusType, statuses: statuses.length ? statuses : STATUS_OPTIONS.map((o) => o.name) };
  await setMeta(env, 'nschema', schema);
  return schema;
}
const isDoneStatus = (name) => DONE_RE.test(name || '');
const doneStatusOf = (schema) => schema.statuses.find(isDoneStatus) || 'Готово';
const openStatusOf = (schema) => schema.statuses.find((s) => !isDoneStatus(s)) || 'Новые';
function matchStatus(schema, name) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  return schema.statuses.find((s) => s.toLowerCase() === n) || null;
}
const cleanProject = (p) => (PROJECTS.includes(p) ? p : PROJECTS.find((x) => x.toLowerCase() === String(p || '').toLowerCase().trim()) || '');

// Короткие номера задач (#1, #2…) для общения в Telegram; страница Notion ↔ номер
async function numbersFor(env, pageIds) {
  const map = {};
  for (let i = 0; i < pageIds.length; i += 50) {
    const chunk = pageIds.slice(i, i + 50);
    if (!chunk.length) continue;
    const sel = () => env.DB.prepare(`SELECT num, page FROM nums WHERE page IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const r of (await sel()).results || []) map[r.page] = r.num;
    const missing = chunk.filter((id) => !map[id]);
    if (!missing.length) continue;
    await env.DB.batch(missing.map((id) => env.DB.prepare('INSERT OR IGNORE INTO nums (page) VALUES (?)').bind(id)));
    for (const r of (await sel()).results || []) map[r.page] = r.num;
  }
  return map;
}
async function pageOfNum(env, num) {
  const r = await env.DB.prepare('SELECT page FROM nums WHERE num=?').bind(Number(num)).first();
  return r ? r.page : null;
}
function pageToTask(p, num) {
  const pr = p.properties || {};
  const st = pr[P.status] || {};
  const dl = pr[P.deadline] && pr[P.deadline].date;
  return {
    id: num, page: p.id, url: p.url || '',
    title: plain((pr[P.title] || {}).title) || 'Без названия',
    status: (st.select && st.select.name) || (st.status && st.status.name) || '',
    project: (pr[P.project] && pr[P.project].select && pr[P.project].select.name) || '',
    deadline: notionDateToLocal(dl && dl.start),
    created: p.created_time ? nowLocal(Date.parse(p.created_time)) : '',
    next_step: plain((pr[P.step] || {}).rich_text),
  };
}
async function queryPages(env, cfg, body) {
  const out = [];
  let cursor;
  for (let i = 0; i < 3; i++) { // до 300 строк
    const r = await notion(env, 'POST', `/data_sources/${cfg.ds}/query`, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...(r.results || []).filter((p) => p.object === 'page' && !p.in_trash && !p.archived));
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return out;
}
async function toTasks(env, pages) {
  const nums = await numbersFor(env, pages.map((p) => p.id));
  return pages.map((p) => pageToTask(p, nums[p.id]));
}
const byDeadline = (a, b) => (!a.deadline) - (!b.deadline) || String(a.deadline).localeCompare(String(b.deadline)) || a.id - b.id;
async function openTasks(env, cfg, schema) {
  const pages = await queryPages(env, cfg, {
    filter: { property: P.status, [schema.statusType]: { does_not_equal: doneStatusOf(schema) } },
    sorts: [{ property: P.deadline, direction: 'ascending' }],
  });
  return (await toTasks(env, pages)).filter((t) => !isDoneStatus(t.status)).sort(byDeadline);
}
function taskProps(f, schema) {
  const props = {};
  if (f.title) props[P.title] = { title: richText(f.title) };
  if (f.status) props[P.status] = { [schema.statusType]: { name: f.status } };
  if ('project' in f) props[P.project] = { select: f.project ? { name: f.project } : null };
  if ('deadline' in f) props[P.deadline] = { date: f.deadline ? { start: localToIso(f.deadline) } : null };
  if ('next_step' in f) props[P.step] = { rich_text: f.next_step ? richText(f.next_step) : [] };
  return props;
}
async function createTask(env, cfg, schema, f) {
  const page = await notion(env, 'POST', '/pages', {
    parent: { type: 'data_source_id', data_source_id: cfg.ds },
    properties: taskProps({ status: openStatusOf(schema), ...f }, schema),
  });
  return (await toTasks(env, [page]))[0];
}
async function updateTask(env, schema, pageId, f) {
  const page = await notion(env, 'PATCH', '/pages/' + pageId, { properties: taskProps(f, schema) });
  return (await toTasks(env, [page]))[0];
}
async function trashPage(env, pageId) {
  try { await notion(env, 'PATCH', '/pages/' + pageId, { in_trash: true }); } catch (e) {
    if (e.status !== 400) throw e;
    await notion(env, 'PATCH', '/pages/' + pageId, { archived: true });
  }
}
async function taskByNum(env, num) {
  const pageId = await pageOfNum(env, num);
  if (!pageId) return null;
  try {
    const p = await notion(env, 'GET', '/pages/' + pageId);
    if (p.in_trash || p.archived) return null;
    return pageToTask(p, Number(num));
  } catch (e) { if (e.status === 404) return null; throw e; }
}
// Перенос задач, которые лежали в D1 до подключения Notion
async function importOldTasks(env, cfg) {
  const rows = (await env.DB.prepare('SELECT * FROM tasks ORDER BY id').all()).results || [];
  if (!rows.length) return 0;
  const schema = await notionSchema(env, cfg, true);
  let n = 0;
  for (const t of rows) {
    try {
      const done = /done|готов/i.test(t.status || '');
      await createTask(env, cfg, schema, {
        title: t.title, project: cleanProject(t.project) || '', deadline: parseDt(t.deadline), next_step: t.next_step || '',
        status: done ? doneStatusOf(schema) : openStatusOf(schema),
      });
      await env.DB.prepare('DELETE FROM tasks WHERE id=?').bind(t.id).run();
      n++;
    } catch (e) { console.log('import failed', t.id, String(e)); }
  }
  return n;
}
// Подготовка: всё, что нужно для работы с задачами; при ошибке подключения — понятный текст
async function taskCtx(env) {
  const cfg = await ensureNotion(env);
  const schema = await notionSchema(env, cfg);
  return { cfg, schema };
}
const setupHint = (e) => (e instanceof NotionSetupError ? '⚠️ ' + e.message : '⚠️ Notion сейчас не ответил, попробуй через минуту.');

// ---------- Карточки ----------
function taskCard(t, head = '✅ Задача') {
  const lines = [`${head} #${t.id}`, `<b>${esc(t.title)}</b>`, `⏰ Дедлайн: ${human(t.deadline)}`];
  if (t.project) lines.push(`📁 Проект: ${esc(t.project)}`);
  if (t.status) lines.push(`📌 Статус: ${esc(t.status)}`);
  if (t.next_step) lines.push(`👉 Следующий шаг: ${esc(t.next_step)}`);
  if (t.created) lines.push(`🕒 Поставлена: ${human(t.created)}`);
  if (t.url) lines.push(`<a href="${escAttr(t.url)}">Открыть в Notion</a>`);
  return lines.join('\n');
}
function listText(tasks, url) {
  const link = url ? `\n\n<a href="${escAttr(url)}">Все задачи в Notion</a>` : '';
  if (!tasks.length) return 'Открытых задач нет.' + link;
  const now = nowLocal();
  return '📋 <b>Открытые задачи</b>\n' + tasks.map((t) =>
    `#${t.id} ${esc(t.title)}${t.project ? ` [${esc(t.project)}]` : ''} — ${human(t.deadline)}${t.deadline && t.deadline < now ? ' 🔴 просрочено' : ''}`).join('\n') + link;
}
function tasksForPrompt(tasks) {
  if (!tasks.length) return 'Открытых задач нет.';
  return tasks.map((t) => `#${t.id} | ${t.title} | проект: ${t.project || '-'} | статус: ${t.status || '-'} | дедлайн: ${(t.deadline || '-').replace('T', ' ')} | поставлена: ${(t.created || '-').replace('T', ' ')} | следующий шаг: ${t.next_step || '-'}`).join('\n');
}

// ---------- Времена намаза ----------
async function fetchSajda(ym) {
  const [y, m] = ym.split('-').map(Number);
  const input = { 0: { json: { year: y, month: m, geonameId: SAJDA_GEONAME, methodId: SAJDA_METHOD, locale: 'ru' } } };
  const r = await fetch('https://sajda.com/v2/api/trpc/prayerTimes.getMonthlyPrayerTimes?batch=1&input=' + encodeURIComponent(JSON.stringify(input)),
    { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (JeffBot; personal prayer reminder)' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('sajda ' + r.status);
  const j = await r.json();
  const payload = j[0].result.data.json.payload;
  const hm = (iso) => nowLocal(Date.parse(iso)).slice(11, 16);
  const days = {};
  for (const d of payload) days[d.date] = { bomdod: hm(d.fajr), quyosh: hm(d.sunrise), peshin: hm(d.dhuhr), asr: hm(d.asr), shom: hm(d.maghrib), xufton: hm(d.isha) };
  if (Object.keys(days).length < 28) throw new Error('sajda: мало дней');
  return { source: 'sajda.com', days };
}
async function fetchNamozVaqti(ym) {
  const r = await fetch(`https://namoz-vaqti.uz/index.php?region=toshkent-shahri&lang=en&period=${ym}&format=json`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('namoz-vaqti ' + r.status);
  const j = await r.json();
  const days = {};
  for (const row of j.period_table) {
    const [dd, mm, yy] = row.date.split('.');
    const t = row.times;
    days[`${yy}-${mm}-${dd}`] = { bomdod: t.bomdod, quyosh: t.quyosh, peshin: t.peshin, asr: t.asr, shom: t.shom, xufton: t.xufton };
  }
  if (Object.keys(days).length < 28) throw new Error('namoz-vaqti: мало дней');
  return { source: 'namoz-vaqti.uz', days };
}
async function monthTimes(env, ym) {
  const cached = await getMeta(env, 'times:' + ym);
  if (cached && cached.days && (cached.source === 'sajda.com' || Date.now() - (cached.at || 0) < 6 * 3600e3)) return cached;
  const fail = await getMeta(env, 'times_fail:' + ym, 0);
  if (!cached && Date.now() - fail < 10 * 60e3) return null;
  let data = null;
  for (const f of [fetchSajda, fetchNamozVaqti]) {
    try { data = await f(ym); break; } catch (e) { console.log('times', String(e)); }
  }
  if (!data) { await setMeta(env, 'times_fail:' + ym, Date.now()); return cached || null; }
  data.at = Date.now();
  await setMeta(env, 'times:' + ym, data);
  return data;
}
async function daySchedule(env, date) {
  const m = await monthTimes(env, date.slice(0, 7));
  const t = m && m.days[date];
  if (!t) return null;
  return {
    source: m.source, sunrise: t.quyosh,
    list: [
      { key: 'bomdod', name: 'Бомдод', time: t.bomdod, end: t.quyosh },
      { key: 'peshin', name: 'Пешин', time: t.peshin, end: t.asr },
      { key: 'asr', name: 'Аср', time: t.asr, end: t.shom },
      { key: 'shom', name: 'Шом', time: t.shom, end: t.xufton },
      { key: 'xufton', name: 'Хуфтон', time: t.xufton, end: '23:59' },
      { key: 'vitr', name: 'Витр', time: addMin(t.xufton, VITR_AFTER_MIN), end: '23:59' },
    ],
  };
}
const prayerName = (key) => (PRAYERS.find((p) => p.key === key) || {}).name || key;

async function markPrayer(env, date, key, done) {
  if (!validDate(date) || !PRAYERS.some((p) => p.key === key)) return false;
  const d = await getDay(env, date);
  if (done) d.prayers[key] = nowLocal().slice(11, 16); else delete d.prayers[key];
  await saveDay(env, date, d);
  if (done) { // убираем висящее напоминание
    const ping = await env.DB.prepare('SELECT msg FROM pings WHERE date=? AND key=?').bind(date, key).first();
    const chat = (await getMeta(env, 'cfg', {})).chat;
    if (ping && ping.msg && chat) await tg(env, 'deleteMessage', { chat_id: chat, message_id: ping.msg });
    await env.DB.prepare('INSERT INTO pings (date, key, last, msg) VALUES (?, ?, -1, NULL) ON CONFLICT(date, key) DO UPDATE SET last=-1, msg=NULL').bind(date, key).run();
  }
  return true;
}

async function prayerStatus(env, date) {
  const [sch, day] = [await daySchedule(env, date), await getDay(env, date)];
  const lines = [`🕌 <b>Молитвы · ${date.slice(8, 10)}.${date.slice(5, 7)}</b>`];
  const kb = [];
  for (const p of PRAYERS) {
    const s = sch && sch.list.find((x) => x.key === p.key);
    const done = day.prayers[p.key];
    lines.push(`${done ? '✅' : '▫️'} ${p.name}${s ? ' — ' + s.time : ''}${done && done !== true ? ` · отмечено в ${done}` : ''}`);
    if (!done) kb.push({ text: '✅ ' + p.name, callback_data: `p:${date}:${p.key}` });
  }
  lines.push('', `📿 Истигфар: <b>${day.istighfar}</b>`, `${day.vakia ? '✅' : '▫️'} Сура Аль-Вакиа`);
  if (!sch) lines.push('', 'Время намазов сейчас недоступно, попробую загрузить позже.');
  else lines.push('', `Время: ${sch.source}`);
  const rows = [];
  for (let i = 0; i < kb.length; i += 3) rows.push(kb.slice(i, i + 3));
  rows.push([{ text: day.vakia ? '↩️ Аль-Вакиа не прочитана' : '✅ Аль-Вакиа прочитана', callback_data: `v:${date}` }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// ---------- Действия ----------
const TASK_ACTIONS = ['add', 'done', 'update', 'delete', 'list'];
async function applyActions(env, actions) {
  const out = [];
  let tc = null, tcError = null;
  const ctx = async () => {
    if (tc || tcError) return tc;
    try { tc = await taskCtx(env); } catch (e) { tcError = e; console.log('notion ctx', String(e)); }
    return tc;
  };
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a !== 'object') continue;
    try {
      if (TASK_ACTIONS.includes(a.type)) {
        if (!(await ctx())) continue;
        const { cfg, schema } = tc;
        if (a.type === 'add' && a.title) {
          const t = await createTask(env, cfg, schema, {
            title: String(a.title).trim().slice(0, 500), project: cleanProject(a.project), deadline: parseDt(a.deadline),
            next_step: a.next_step ? String(a.next_step).slice(0, 300) : '', status: matchStatus(schema, a.status) || openStatusOf(schema),
          });
          out.push(taskCard(t));
        } else if (a.type === 'done') {
          const t = await taskByNum(env, a.id);
          if (t && !isDoneStatus(t.status)) {
            await updateTask(env, schema, t.page, { status: doneStatusOf(schema) });
            out.push(`🏁 Закрыта #${t.id}: <b>${esc(t.title)}</b>`);
          } else out.push(`Задачи #${a.id} нет среди открытых.`);
        } else if (a.type === 'update') {
          const t = await taskByNum(env, a.id);
          if (!t) { out.push(`Задачи #${a.id} не нашёл.`); continue; }
          const f = {};
          if (a.title) f.title = String(a.title).trim().slice(0, 500);
          if (a.next_step) f.next_step = String(a.next_step).slice(0, 300);
          if (a.project) f.project = cleanProject(a.project);
          if ('deadline' in a) f.deadline = parseDt(a.deadline);
          const st = matchStatus(schema, a.status);
          if (st) f.status = st;
          if (Object.keys(f).length) out.push(taskCard(await updateTask(env, schema, t.page, f), '✏️ Обновлена'));
        } else if (a.type === 'delete') {
          const t = await taskByNum(env, a.id);
          if (t) { await trashPage(env, t.page); out.push(`🗑 Удалена #${t.id}: ${esc(t.title)} (лежит в корзине Notion)`); }
        } else if (a.type === 'list') {
          out.push(listText(await openTasks(env, cfg, schema), cfg.url));
        }
      } else if (a.type === 'prayer' && PRAYERS.some((p) => p.key === a.key)) {
        const date = validDate(a.date) ? a.date : today();
        await markPrayer(env, date, a.key, a.done !== false);
        out.push(`${a.done === false ? '↩️ Снял отметку' : '✅ Отметил'}: ${prayerName(a.key)}`);
      } else if (a.type === 'istighfar' && isFinite(Number(a.value))) {
        const d = await getDay(env, today());
        d.istighfar = Math.max(0, Math.round(a.mode === 'add' ? d.istighfar + Number(a.value) : Number(a.value)));
        await saveDay(env, today(), d);
        out.push(`📿 Истигфар сегодня: <b>${d.istighfar}</b>`);
      } else if (a.type === 'vakia') {
        const d = await getDay(env, today());
        d.vakia = a.done !== false;
        await saveDay(env, today(), d);
        out.push(d.vakia ? '✅ Сура Аль-Вакиа отмечена' : '↩️ Снял отметку Аль-Вакиа');
      } else if (a.type === 'prayers') {
        out.push((await prayerStatus(env, today())).text);
      }
    } catch (e) {
      console.log('action failed', JSON.stringify(a), String(e));
      if (TASK_ACTIONS.includes(a.type)) out.push(setupHint(e));
    }
  }
  if (tcError) out.unshift(setupHint(tcError));
  return out;
}

// ---------- LLM ----------
const SYSTEM = `Ты — Джефф, личный ассистент и ментор предпринимателя. Он пишет тебе в Telegram как в обычный чат.
Твоя работа: превращать его сообщения в чёткие задачи, вести список в Notion и помогать его закрывать. Ты также ведёшь его намазы, истигфар и чтение суры Аль-Вакиа.

Отвечай ТОЛЬКО JSON-объектом:
{"reply": "текст ответа", "actions": [ ... ]}

Виды действий:
{"type": "add", "title": "...", "deadline": "YYYY-MM-DD HH:MM" или null, "project": "Newton" | "Be Soft" | null, "next_step": "..." или null}
{"type": "done", "id": 12}
{"type": "update", "id": 12, "title": "...", "deadline": "...", "project": "...", "next_step": "...", "status": "название статуса"}  (только изменяемые поля)
{"type": "delete", "id": 12}
{"type": "list"}
{"type": "prayer", "key": "bomdod" | "peshin" | "asr" | "shom" | "xufton" | "vitr", "done": true}
{"type": "istighfar", "value": 300, "mode": "set" | "add"}
{"type": "vakia", "done": true}
{"type": "prayers"}  (показать сводку молитв за сегодня)

Правила:
- Формулируй задачу грамотно: начинай с глагола, конкретный измеримый результат, без воды. Сохраняй имена, названия, ссылки и цифры в точности как написал пользователь.
- В одном сообщении может быть несколько задач — создай каждую отдельно.
- Проект: только "Newton" или "Be Soft", если из сообщения это понятно; иначе null.
- Дедлайн: если пользователь назвал срок («завтра», «до пятницы», «через 2 часа») — переведи в точную дату и время от текущего момента. Если день есть, а времени нет — ставь 18:00. Если срока нет совсем — предложи реалистичный сам и скажи об этом в reply.
- Не ставь дедлайн в прошлое.
- next_step — первое конкретное действие на 5–15 минут, если оно очевидно.
- «сделал», «готово», «закрыл» → done по подходящей задаче из списка. «перенеси», «сдвинь» → update. Номера задач бери только из списка ниже. Если непонятно, о какой задаче речь, — спроси, действий не делай.
- «прочитал аср», «бомдод прочитан» → prayer. «истигфар 300» → istighfar с mode "set"; «ещё 100 истигфара» → mode "add". «прочитал Вакиа» → vakia.
- Если это вопрос или разговор, а не задача, — просто ответь в reply, actions пустой.
- reply: коротко, по делу, на «ты», по-русски. Не пересказывай карточки — бот покажет их сам. Ты ментор: если задач слишком много, дедлайны нереальные или пользователь распыляется — скажи прямо.`;

async function llm(env, messages, jsonMode = true) {
  let last = new Error('LLM недоступна');
  for (const model of LLM_MODELS) {
    try {
      const body = { model, messages, temperature: 0.3 };
      if (jsonMode) body.response_format = { type: 'json_object' };
      const r = await fetch(LLM_BASE + '/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env.LLM_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (!r.ok) { last = new Error('LLM ' + r.status); if (r.status !== 404 && r.status !== 429 && r.status < 500) throw last; continue; }
      const j = await r.json();
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (text) return text;
    } catch (e) { last = e; if (/^LLM 4/.test(String(e.message)) && !/404|429/.test(e.message)) break; console.log('llm', model, String(e)); }
  }
  throw last;
}
function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return { reply: String(text || ''), actions: [] };
}
// Контекст для модели: время, статусы и открытые задачи из Notion
async function contextHeader(env) {
  const n = nowLocal();
  const d = new Date(n + ':00Z');
  let tasksText, statuses = STATUS_OPTIONS.map((o) => o.name).join(', ');
  try {
    const { cfg, schema } = await taskCtx(env);
    statuses = schema.statuses.join(', ');
    tasksText = tasksForPrompt(await openTasks(env, cfg, schema));
  } catch (e) {
    tasksText = '(список задач недоступен: Notion не ответил)';
  }
  return `Сейчас: ${n.replace('T', ' ')}, ${WEEKDAYS[d.getUTCDay()]} (Ташкент).\nСтатусы задач в Notion: ${statuses}.\nОткрытые задачи:\n${tasksText}`;
}

// ---------- Обработка сообщений ----------
function welcome() {
  return 'Привет, я Джефф.\n\nПиши задачи как в обычный чат — я сформулирую, поставлю дедлайн и добавлю в Notion.\n' +
    'Например: «завтра до обеда отправить КП клиенту и созвониться с Азизом в четверг».\n\n' +
    '«Сделал КП» — закрою. «Перенеси созвон на пятницу» — перенесу. Правки, которые ты делаешь прямо в Notion, я тоже вижу.\n' +
    `Утром в ${MORNING} пришлю план, вечером в ${EVENING} — разбор дня. О дедлайнах напомню за час и в момент дедлайна.\n\n` +
    '🕌 В время намаза напомню и буду повторять каждые 10 минут, пока не отметишь.\n\n' +
    '/tasks — задачи, /notion — база в Notion, /namoz — молитвы, /istigfar 300 — истигфар за сегодня.';
}
async function onMessage(env, msg) {
  if (!msg.from || msg.chat.type !== 'private') return;
  const cfg = await getMeta(env, 'cfg', {});
  const uid = String(msg.from.id);
  const text = (msg.text || '').trim();
  if (!cfg.owner) {
    cfg.owner = uid; cfg.chat = msg.chat.id;
    await setMeta(env, 'cfg', cfg);
  }
  if (uid !== cfg.owner) return;
  if (cfg.chat !== msg.chat.id) { cfg.chat = msg.chat.id; await setMeta(env, 'cfg', cfg); }
  if (!text) return;
  const chat = msg.chat.id;

  if (/^\/start/.test(text)) return send(env, chat, welcome());
  if (/^\/(tasks|notion)/.test(text)) {
    try {
      const { cfg: n, schema } = await taskCtx(env);
      if (/^\/notion/.test(text)) return send(env, chat, n.url ? `<a href="${escAttr(n.url)}">${NOTION_DB_TITLE}</a> — база задач в Notion.` : 'База задач подключена, но ссылку Notion не вернул.');
      return send(env, chat, listText(await openTasks(env, n, schema), n.url));
    } catch (e) { console.log('tasks cmd', String(e)); return send(env, chat, setupHint(e)); }
  }
  if (/^\/namoz/.test(text)) { const s = await prayerStatus(env, today()); return send(env, chat, s.text, { reply_markup: s.reply_markup }); }
  let m = text.match(/^\/istigfar(?:@\w+)?\s*(\+)?\s*(\d+)?/);
  if (m) {
    if (!m[2]) { const d = await getDay(env, today()); return send(env, chat, `📿 Истигфар сегодня: <b>${d.istighfar}</b>\nЗаписать: /istigfar 300, добавить: /istigfar +100`); }
    return send(env, chat, (await applyActions(env, [{ type: 'istighfar', value: Number(m[2]), mode: m[1] ? 'add' : 'set' }])).join('\n'));
  }
  m = text.match(/^\/(done|del)(?:@\w+)?\s*#?(\d+)?/);
  if (m) {
    if (!m[2]) return send(env, chat, 'Укажи номер задачи, например: /done 3');
    const out = await applyActions(env, [{ type: m[1] === 'done' ? 'done' : 'delete', id: Number(m[2]) }]);
    return send(env, chat, out.join('\n') || 'Такой открытой задачи нет.');
  }
  if (text.startsWith('/')) return send(env, chat, 'Не знаю такой команды. Есть: /tasks, /notion, /namoz, /istigfar.');

  await tg(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
  const hist = await getMeta(env, 'hist', []);
  let data;
  try {
    data = extractJson(await llm(env, [{ role: 'system', content: SYSTEM + '\n\n' + (await contextHeader(env)) }, ...hist, { role: 'user', content: text }]));
  } catch (e) {
    console.log('llm failed', String(e));
    return send(env, chat, 'Не смог обработать — модель не ответила. Попробуй ещё раз.');
  }
  const blocks = await applyActions(env, data.actions);
  const reply = String(data.reply || '').trim();
  hist.push({ role: 'user', content: text }, { role: 'assistant', content: reply || 'Готово.' });
  await setMeta(env, 'hist', hist.slice(-12));
  return send(env, chat, [...blocks, reply ? esc(reply) : ''].filter(Boolean).join('\n\n') || 'Готово.');
}

async function onCallback(env, cq) {
  const cfg = await getMeta(env, 'cfg', {});
  if (!cfg.owner || String(cq.from.id) !== cfg.owner) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const data = cq.data || '';
  const msg = cq.message;
  let note = '';
  let m = data.match(/^p:(\d{4}-\d{2}-\d{2}):(\w+)$/);
  if (m && (await markPrayer(env, m[1], m[2], true))) note = `${prayerName(m[2])} отмечен`;
  m = data.match(/^v:(\d{4}-\d{2}-\d{2})$/);
  if (m) { const d = await getDay(env, m[1]); d.vakia = !d.vakia; await saveDay(env, m[1], d); note = d.vakia ? 'Аль-Вакиа отмечена' : 'Отметка снята'; }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: note });
  if (!msg) return;
  if (/^🕌 <b>Молитвы|^🕌 Молитвы/.test(msg.text || '')) { // сводка — перерисовываем
    const date = (data.match(/\d{4}-\d{2}-\d{2}/) || [today()])[0];
    const s = await prayerStatus(env, date);
    return tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: s.text, parse_mode: 'HTML', reply_markup: s.reply_markup });
  }
  if (/^p:/.test(data)) { // напоминание — заменяем подтверждением (markPrayer мог уже удалить сообщение)
    const key = data.split(':')[2];
    const r = await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `✅ ${prayerName(key)} — прочитан, отмечено в ${nowLocal().slice(11, 16)}` });
    if (!r.ok) await send(env, msg.chat.id, `✅ ${prayerName(key)} — прочитан, отмечено в ${nowLocal().slice(11, 16)}`);
  }
}

// ---------- Расписание ----------
async function cronPrayers(env, chat) {
  const date = today();
  const hm = nowLocal().slice(11, 16);
  const sch = await daySchedule(env, date);
  if (!sch) return;
  const day = await getDay(env, date);
  const pings = {};
  for (const r of (await env.DB.prepare('SELECT * FROM pings WHERE date=?').bind(date).all()).results || []) pings[r.key] = r;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const p of sch.list) {
    if (day.prayers[p.key]) continue;
    const ping = pings[p.key];
    if (ping && ping.last === -1) continue;
    const button = { inline_keyboard: [[{ text: '✅ Прочитал', callback_data: `p:${date}:${p.key}` }]] };
    if (hm >= p.time && hm < p.end) {
      if (ping && nowSec - ping.last < PING_EVERY_SEC - 20) continue;
      const [eh, em] = p.end.split(':').map(Number), [nh, nm] = hm.split(':').map(Number);
      const left = eh * 60 + em - nh * 60 - nm;
      const leftText = left >= 60 ? `${Math.floor(left / 60)} ч ${left % 60} мин` : `${left} мин`;
      const text = ping
        ? `⏰ <b>${p.name}</b> ещё не отмечен\nВремя наступило в ${p.time}, осталось ${leftText}.`
        : `🕌 Время намаза: <b>${p.name}</b> — ${p.time}`;
      const r = await send(env, chat, text, { reply_markup: button });
      if (ping && ping.msg) await tg(env, 'deleteMessage', { chat_id: chat, message_id: ping.msg });
      await env.DB.prepare('INSERT INTO pings (date, key, last, msg) VALUES (?, ?, ?, ?) ON CONFLICT(date, key) DO UPDATE SET last=excluded.last, msg=excluded.msg')
        .bind(date, p.key, nowSec, r.ok ? r.result.message_id : null).run();
    } else if (hm >= p.end && ping && ping.last > 0) {
      const r = await send(env, chat, `⌛️ Время намаза <b>${p.name}</b> вышло, он не отмечен.\nЕсли прочитал — отметь.`, { reply_markup: button });
      if (ping.msg) await tg(env, 'deleteMessage', { chat_id: chat, message_id: ping.msg });
      await env.DB.prepare('UPDATE pings SET last=-1, msg=? WHERE date=? AND key=?').bind(r.ok ? r.result.message_id : null, date, p.key).run();
    }
  }
}
// Дедлайны читаются из Notion каждую минуту — правки в Notion учитываются сразу
async function cronDeadlines(env, chat) {
  let tc;
  try { tc = await taskCtx(env); } catch (e) { if (!(e instanceof NotionSetupError)) console.log('deadlines', String(e)); return; }
  const { cfg, schema } = tc;
  const now = nowLocal();
  const soon = nowLocal(Date.now() + REMIND_BEFORE_MIN * 60000);
  const pages = await queryPages(env, cfg, {
    filter: { and: [
      { property: P.deadline, date: { on_or_before: localToIso(soon) } },
      { property: P.status, [schema.statusType]: { does_not_equal: doneStatusOf(schema) } },
    ] },
  });
  const tasks = (await toTasks(env, pages)).filter((t) => t.deadline && t.deadline <= soon && !isDoneStatus(t.status));
  for (const t of tasks) {
    const rec = await env.DB.prepare('SELECT deadline, stage FROM nrem WHERE page=?').bind(t.page).first();
    const stageNow = rec && rec.deadline === t.deadline ? rec.stage : 0; // перенесли дедлайн — напоминаем заново
    let text, stage;
    const link = t.url ? `\n<a href="${escAttr(t.url)}">Открыть в Notion</a>` : '';
    if (t.deadline <= now && stageNow < 2) { text = `🔴 Дедлайн прошёл: #${t.id} <b>${esc(t.title)}</b>\nСделал или переносим?${link}`; stage = 2; }
    else if (t.deadline > now && stageNow < 1) { text = `⏰ Скоро дедлайн (${human(t.deadline)}): #${t.id} <b>${esc(t.title)}</b>${link}`; stage = 1; }
    else continue;
    await send(env, chat, text);
    await env.DB.prepare('INSERT INTO nrem (page, deadline, stage) VALUES (?, ?, ?) ON CONFLICT(page) DO UPDATE SET deadline=excluded.deadline, stage=excluded.stage')
      .bind(t.page, t.deadline, stage).run();
  }
}
async function doneToday(env) {
  try {
    const { cfg, schema } = await taskCtx(env);
    const start = localToIso(today() + 'T00:00');
    const pages = await queryPages(env, cfg, { filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: start } } });
    return (await toTasks(env, pages)).filter((t) => isDoneStatus(t.status)).map((t) => t.title);
  } catch { return []; }
}
async function cronDigest(env, chat) {
  const date = today(), hm = nowLocal().slice(11, 16);
  const sent = await getMeta(env, 'digest', {});
  let mode = null;
  if (hm >= MORNING && hm < addMin(MORNING, 30) && sent.morning !== date) mode = 'morning';
  else if (hm >= EVENING && hm < addMin(EVENING, 30) && sent.evening !== date) mode = 'evening';
  if (!mode) return;
  sent[mode] = date;
  await setMeta(env, 'digest', sent);
  let ask;
  if (mode === 'morning') {
    ask = 'Утро. Составь план на день: выбери не больше 3 главных задач на сегодня и объясни почему, отдельно назови просроченные. Если задач нет — спроси, что сегодня главное.';
  } else {
    const done = (await doneToday(env)).join('; ') || 'ничего';
    const d = await getDay(env, date);
    const missed = PRAYERS.filter((p) => !d.prayers[p.key] && p.key !== 'xufton' && p.key !== 'vitr').map((p) => p.name).join(', ') || 'нет';
    ask = `Вечер. Закрыто сегодня: ${done}. Неотмеченные намазы за день: ${missed}. Истигфар: ${d.istighfar}. Аль-Вакиа: ${d.vakia ? 'прочитана' : 'не отмечена'}. ` +
      'Сделай короткий разбор дня: что закрыто, что зависло, что переносим. Спроси про одну самую важную незакрытую задачу — что мешает.';
  }
  let text;
  try {
    text = await llm(env, [
      { role: 'system', content: 'Ты — Джефф, ментор предпринимателя. Пиши коротко, прямо, на «ты», по-русски, обычным текстом без разметки. Ссылайся на задачи по номерам.\n\n' + (await contextHeader(env)) },
      { role: 'user', content: ask }], false);
  } catch { text = null; }
  if (text) await tg(env, 'sendMessage', { chat_id: chat, text });
}
async function runCron(env) {
  await ensureSchema(env);
  const cfg = await getMeta(env, 'cfg', {});
  if (!cfg.chat) return;
  for (const job of [() => cronPrayers(env, cfg.chat), () => cronDeadlines(env, cfg.chat), () => cronDigest(env, cfg.chat)]) {
    try { await job(); } catch (e) { console.log('cron job failed', String(e && e.stack || e)); }
  }
}

// ---------- Настройка ----------
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
async function setup(env, origin) {
  await ensureSchema(env);
  const out = {};
  const me = await tg(env, 'getMe', {});
  if (!me.ok) {
    out.telegramError = me.description || 'нет ответа от Telegram';
    // Только вид ключей, без значений: помогает понять, что куда вставлено.
    const kind = (v) => !v ? 'пусто' : /^\d{6,}:[\w-]{30,}$/.test(v) ? 'похоже на токен Telegram'
      : /^AIza[\w-]{20,}$/.test(v) ? 'похоже на ключ Gemini' : /^(ntn_|secret_)/.test(v) ? 'похоже на ключ Notion' : 'непонятный формат, длина ' + v.length;
    out.keys = { TELEGRAM_TOKEN: kind(env.TELEGRAM_TOKEN), LLM_API_KEY: kind(env.LLM_API_KEY), NOTION_TOKEN: kind(env.NOTION_TOKEN) };
  }
  else out.bot = me.result.username;
  out.webhook = (await tg(env, 'setWebhook', { url: origin + '/tg', secret_token: await webhookSecret(env), allowed_updates: ['message', 'callback_query'], drop_pending_updates: false })).ok;
  out.menu = (await tg(env, 'setChatMenuButton', { menu_button: { type: 'commands' } })).ok;
  out.commands = (await tg(env, 'setMyCommands', { commands: [
    { command: 'tasks', description: 'Открытые задачи' }, { command: 'notion', description: 'База задач в Notion' },
    { command: 'namoz', description: 'Молитвы на сегодня' }, { command: 'istigfar', description: 'Истигфар за сегодня: /istigfar 300' }] })).ok;
  try {
    const n = await ensureNotion(env);
    await notionSchema(env, n, true);
    out.notion = true; out.notionUrl = n.url || null;
  } catch (e) { out.notion = false; out.notionError = e.message; }
  return out;
}

// Чистим ключи: пробелы, кавычки, «NAME=» в начале — частые ошибки при вставке.
function cleanEnv(env) {
  if (env.__clean) return env;
  const out = Object.create(env);
  for (const k of ['TELEGRAM_TOKEN', 'LLM_API_KEY', 'NOTION_TOKEN']) {
    if (typeof env[k] !== 'string') continue;
    let v = env[k].trim().replace(/^[A-Z_]+\s*=\s*/, '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    v = v.replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, '');
    if (k === 'TELEGRAM_TOKEN') { const m = v.match(/\d{6,}:[A-Za-z0-9_-]{30,}/); if (m) v = m[0]; }
    v = v.split(/\s+/)[0] || '';
    out[k] = v;
  }
  out.__clean = true;
  return out;
}

export default {
  async fetch(req, env0, ctx) {
    const env = cleanEnv(env0);
    const url = new URL(req.url);
    if (url.pathname !== '/jeff' && !url.pathname.startsWith('/jeff/')) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('not found', { status: 404 });
    }
    const path = url.pathname.slice(5) || '/';
    if (path !== '/' && (!env.TELEGRAM_TOKEN || !env.DB)) return new Response('Джефф не настроен: нет ключей или базы.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    try {
      if (path === '/tg' && req.method === 'POST') {
        if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (await webhookSecret(env))) return new Response('forbidden', { status: 403 });
        const update = await req.json();
        ctx.waitUntil((async () => {
          try {
            await ensureSchema(env);
            if (update.message) await onMessage(env, update.message);
            else if (update.callback_query) await onCallback(env, update.callback_query);
          } catch (e) {
            console.log('update failed', String(e && e.stack || e));
            try { await setMeta(env, 'last_error', { at: nowLocal(), error: String(e && e.message || e).slice(0, 300) }); } catch (_) {}
          }
        })());
        return new Response('ok');
      }
      if (path === '/status') {
        await ensureSchema(env);
        const w = await tg(env, 'getWebhookInfo', {});
        const cfg = await getMeta(env, 'cfg', {});
        const r = w.result || {};
        return json({ webhookUrl: r.url || null, pending: r.pending_update_count, telegramLastError: r.last_error_message || null,
          telegramLastErrorAt: r.last_error_date ? new Date(r.last_error_date * 1000).toISOString() : null,
          ownerSet: !!cfg.owner, lastError: await getMeta(env, 'last_error', null), now: nowLocal() });
      }
      if (path === '/setup') return json(await setup(env, url.origin + '/jeff'));
      if (path === '/cron') { // тик расписания; не чаще раза в 45 секунд, кто бы ни вызвал
        await ensureSchema(env);
        const last = await getMeta(env, 'cron_at', 0);
        if (Date.now() - last < 45000) return new Response('skip');
        await setMeta(env, 'cron_at', Date.now());
        ctx.waitUntil(runCron(env));
        return new Response('ok');
      }
      return new Response('Джефф на связи.', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } catch (e) {
      console.log('fetch failed', String(e && e.stack || e));
      return json({ error: 'server error' }, 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runCron(cleanEnv(env))); },
};
