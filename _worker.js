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
const SUNRISE_BEFORE_MIN = 15; // о восходе пишем за 15 минут
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// Notion: названия колонок базы. Если переименуешь колонку в Notion — поменяй и здесь.
const NOTION_VERSION = '2025-09-03';
const NOTION_DB_TITLE = 'Задачи Джеффа';
const P = { title: 'Задача', status: 'Статус', project: 'Проект', deadline: 'Дедлайн', created: 'Поставлена', step: 'Следующий шаг', planned: 'План (мин)', spent: 'Затрачено (мин)' };
const STATUS_OPTIONS = [
  { name: 'Список', color: 'gray' }, { name: 'Задачи на неделю', color: 'blue' },
  { name: 'Сегодня', color: 'orange' }, { name: 'Завтра', color: 'yellow' }, { name: 'Готово', color: 'green' },
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
  // режим «Занят»: входящие в личку владельца (Telegram Business) и в каких чатах уже ответили
  'CREATE TABLE IF NOT EXISTS bizq (id INTEGER PRIMARY KEY AUTOINCREMENT, chat INTEGER NOT NULL, name TEXT, username TEXT, text TEXT, at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS bizdone (chat INTEGER NOT NULL, period TEXT NOT NULL, PRIMARY KEY (chat, period))',
  // группы, где состоит Джефф, и их последние сообщения
  'CREATE TABLE IF NOT EXISTS gchats (id INTEGER PRIMARY KEY, title TEXT, type TEXT, active INTEGER NOT NULL DEFAULT 1, updated TEXT)',
  'CREATE TABLE IF NOT EXISTS gmsgs (id INTEGER PRIMARY KEY AUTOINCREMENT, chat INTEGER NOT NULL, name TEXT, text TEXT, at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS gmsgs_chat ON gmsgs (chat, id)',
  // таймеры задач: сколько выделено, когда начал, предупредили ли
  'CREATE TABLE IF NOT EXISTS timers (id INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT NOT NULL, num INTEGER, title TEXT, started INTEGER NOT NULL, budget INTEGER NOT NULL, warned INTEGER NOT NULL DEFAULT 0, over INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, msg INTEGER)',
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
        [P.planned]: { number: { format: 'number' } },
        [P.spent]: { number: { format: 'number' } },
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
  const missing = [P.planned, P.spent].filter((k) => !(src.properties || {})[k]);
  if (missing.length) { // колонки учёта времени — добавляем в старую базу
    try { await notion(env, 'PATCH', '/data_sources/' + cfg.ds, { properties: Object.fromEntries(missing.map((k) => [k, { number: { format: 'number' } }])) }); }
    catch (e) { console.log('add time columns', String(e)); }
  }
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
    planned: pr[P.planned] && typeof pr[P.planned].number === 'number' ? pr[P.planned].number : null,
    spent: pr[P.spent] && typeof pr[P.spent].number === 'number' ? pr[P.spent].number : null,
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
  if ('planned' in f) props[P.planned] = { number: f.planned == null ? null : Math.round(f.planned) };
  if ('spent' in f) props[P.spent] = { number: f.spent == null ? null : Math.round(f.spent) };
  return props;
}
// Кэш открытых задач для подсказки модели: Notion отвечает ~0.5–1.5 с, а нужен он почти каждому сообщению
const CTX_TTL_MS = 45000;
async function cachedOpenTasks(env, cfg, schema) {
  const c = await getMeta(env, 'ctx_tasks', null);
  if (c && Date.now() - c.at < CTX_TTL_MS) return c.tasks;
  const tasks = await openTasks(env, cfg, schema);
  await setMeta(env, 'ctx_tasks', { at: Date.now(), tasks });
  return tasks;
}
const dropTaskCache = (env) => env.DB.prepare("DELETE FROM meta WHERE k='ctx_tasks'").run();
async function createTask(env, cfg, schema, f) {
  await dropTaskCache(env);
  const page = await notion(env, 'POST', '/pages', {
    parent: { type: 'data_source_id', data_source_id: cfg.ds },
    properties: taskProps({ status: openStatusOf(schema), ...f }, schema),
  });
  return (await toTasks(env, [page]))[0];
}
async function updateTask(env, schema, pageId, f) {
  await dropTaskCache(env);
  const page = await notion(env, 'PATCH', '/pages/' + pageId, { properties: taskProps(f, schema) });
  return (await toTasks(env, [page]))[0];
}
async function trashPage(env, pageId) {
  await dropTaskCache(env);
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
  if (t.planned || t.spent) lines.push(`⏱ Время: ${fmtMin(t.spent || 0)} из ${t.planned ? fmtMin(t.planned) : '—'}`);
  if (t.created) lines.push(`🕒 Поставлена: ${human(t.created)}`);
  if (t.url) lines.push(`<a href="${escAttr(t.url)}">Открыть в Notion</a>`);
  return lines.join('\n');
}
function shortWhen(local) {
  if (!local) return '';
  const d = new Date(local.slice(0, 10) + 'T00:00:00Z');
  const t = local.slice(11, 16);
  return `${WEEKDAYS[d.getUTCDay()]} ${local.slice(8, 10)}.${local.slice(5, 7)}${t && t !== '00:00' ? ' · ' + t : ''}`;
}
function overdueBy(local, now = Date.now()) {
  const min = Math.floor((now - localToMs(local.length > 10 ? local : local + 'T18:00')) / 60000);
  if (min < 60) return `${Math.max(min, 1)} мин`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} ч`;
  return `${Math.floor(min / 1440)} дн`;
}
// Список задач: секции по срокам, каждая задача — отдельный абзац
function listText(tasks, url) {
  const link = url ? `<a href="${escAttr(url)}">Открыть доску в Notion →</a>` : '';
  if (!tasks.length) return '📋 <b>Открытых задач нет</b> — красота.' + (link ? '\n' + link : '');
  const now = nowLocal(), day = today(), tmr = addDaysStr(day, 1), wEnd = weekEndStr(day);
  const sections = [
    { key: 'over', title: '🔴 <b>Просрочено</b>', items: [] },
    { key: 'today', title: '🔥 <b>Сегодня</b>', items: [] },
    { key: 'tmr', title: '🌅 <b>Завтра</b>', items: [] },
    { key: 'week', title: '📅 <b>На этой неделе</b>', items: [] },
    { key: 'later', title: '🗓 <b>Позже</b>', items: [] },
    { key: 'none', title: '🗂 <b>Без срока</b>', items: [] },
  ];
  const by = Object.fromEntries(sections.map((x) => [x.key, x]));
  for (const t of tasks) {
    const d = (t.deadline || '').slice(0, 10);
    const k = !t.deadline ? 'none' : t.deadline < now ? 'over' : d === day ? 'today' : d === tmr ? 'tmr' : d <= wEnd ? 'week' : 'later';
    by[k].items.push(t);
  }
  const card = (t, k) => {
    const meta = [];
    if (t.deadline) meta.push(k === 'over' ? `⏰ ${shortWhen(t.deadline)} — просрочено на ${overdueBy(t.deadline)}` : `⏰ ${shortWhen(t.deadline)}`);
    if (t.project) meta.push(`📁 ${esc(t.project)}`);
    if (t.planned || t.spent) meta.push(`⏱ ${fmtMin(t.spent || 0)}${t.planned ? '/' + fmtMin(t.planned) : ''}`);
    let out = `<b>#${t.id}</b> ${esc(t.title)}`;
    if (meta.length) out += '\n' + meta.join('  ·  ');
    return out;
  };
  const over = by.over.items.length;
  const head = `📋 <b>Задачи: ${tasks.length}</b>${over ? ` · просрочено ${over}` : ''}`;
  const parts = [head];
  let budget = 3800 - head.length - link.length;
  let hidden = 0;
  for (const sec of sections) {
    if (!sec.items.length) continue;
    const block = [`${sec.title} (${sec.items.length})`];
    for (const t of sec.items) {
      const c = card(t, sec.key);
      if (budget - c.length - 2 < 0) { hidden++; continue; }
      budget -= c.length + 2; block.push(c);
    }
    if (block.length > 1) parts.push(block.join('\n\n'));
  }
  if (hidden) parts.push(`…и ещё ${hidden} — смотри в Notion.`);
  return parts.join('\n\n━━━━━━━━━━\n\n') + (link ? '\n\n' + link : '');
}
function tasksForPrompt(tasks) {
  if (!tasks.length) return 'Открытых задач нет.';
  return tasks.map((t) => `#${t.id} | ${t.title} | проект: ${t.project || '-'} | статус: ${t.status || '-'} | дедлайн: ${(t.deadline || '-').replace('T', ' ')} | поставлена: ${(t.created || '-').replace('T', ' ')} | время: план ${t.planned ?? '-'} мин, потрачено ${t.spent ?? 0} мин`).join('\n');
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
    if (p.key === 'bomdod' && sch && sch.sunrise) lines.push(`🌅 Восход — ${sch.sunrise}`);
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
            status: matchStatus(schema, a.status) || autoColumn(schema, parseDt(a.deadline)) || openStatusOf(schema),
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
          if (a.project) f.project = cleanProject(a.project);
          if ('deadline' in a) f.deadline = parseDt(a.deadline);
          const st = matchStatus(schema, a.status);
          if (st) f.status = st;
          else if (f.deadline && colKey(t.status)) { const ac = autoColumn(schema, f.deadline); if (ac && ac !== t.status) f.status = ac; }
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
      } else if (a.type === 'timer_start' && a.id) {
        const r = await startTimer(env, a.id, a.minutes);
        if (r.kb) { const cfgT = await getMeta(env, 'cfg', {}); await send(env, cfgT.chat, r.text, { reply_markup: r.kb }); } else out.push(r.text);
      } else if (a.type === 'timer_stop') {
        out.push(await stopTimer(env, !!a.done));
      } else if (a.type === 'timer_extend') {
        out.push(await extendTimer(env, a.minutes));
      } else if (a.type === 'group_send') {
        const r = await draftGroupMessage(env, a.group, a.text); if (r) out.push(esc(r));
      } else if (a.type === 'group_read') {
        out.push(esc(await groupDigest(env, a.group, a.limit)));
      } else if (a.type === 'busy') {
        const u = parseDt(a.until); out.push(esc(await setBusy(env, u ? localToMs(u) : null)));
      } else if (a.type === 'free') {
        const cfgB = await getMeta(env, 'cfg', {}); const r = await setFree(env, cfgB.chat); if (r) out.push(esc(r));
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
{"type": "add", "title": "...", "deadline": "YYYY-MM-DD HH:MM" или null, "project": "Newton" | "Be Soft" | null}
{"type": "done", "id": 12}
{"type": "update", "id": 12, "title": "...", "deadline": "...", "project": "...", "status": "название статуса"}  (только изменяемые поля)
Канбан в Notion: колонки «Список» (когда-нибудь), «Задачи на неделю», «Сегодня», «Завтра», «Готово». Колонку по дедлайну бот ставит сам (сегодня/просрочено → Сегодня, завтра → Завтра, до воскресенья → Задачи на неделю, позже или без срока → Список) и каждое утро двигает задачи ближе. Поэтому "status" указывай, только если пользователь явно назвал колонку («закинь в сегодня», «на неделю», «в список»).
{"type": "delete", "id": 12}
{"type": "list"}
{"type": "prayer", "key": "bomdod" | "peshin" | "asr" | "shom" | "xufton" | "vitr", "done": true}
{"type": "istighfar", "value": 300, "mode": "set" | "add"}
{"type": "vakia", "done": true}
{"type": "prayers"}  (показать сводку молитв за сегодня)
{"type": "busy", "until": "YYYY-MM-DD HH:MM" или null}  (пользователь занят: «я на встрече до 5», «не беспокой 2 часа» — пока занят, бот отвечает людям в его личке и потом шлёт сводку)
{"type": "free"}  (пользователь освободился)
{"type": "timer_start", "id": 5, "minutes": 40}  (пользователь начинает задачу: «начинаю #5», «взялся за КП». minutes — сколько он сам назвал; если не назвал — оцени реалистично сам и в reply скажи, сколько поставил)
{"type": "timer_stop", "done": true | false}  («закончил», «стоп», «сделал» — done=true, если задача выполнена; время запишется в Notion)
{"type": "timer_extend", "minutes": 15}  («добавь ещё 15 минут»)
{"type": "group_send", "group": "название группы", "text": "готовый текст сообщения"}  (написать в Telegram-группу, где есть бот; бот покажет черновик с кнопкой «Отправить». Пиши текст от лица ассистента Джеффа или так, как попросил пользователь)
{"type": "group_read", "group": "название группы" или null, "limit": 60}  (прочитать и пересказать, что писали в группе; null — все группы за сутки)

Правила:
- Формулируй задачу грамотно: начинай с глагола, конкретный измеримый результат, без воды. Сохраняй имена, названия, ссылки и цифры в точности как написал пользователь.
- В одном сообщении может быть несколько задач — создай каждую отдельно.
- Проект: только "Newton" или "Be Soft", если из сообщения это понятно; иначе null.
- Дедлайн: если пользователь назвал срок («завтра», «до пятницы», «через 2 часа») — переведи в точную дату и время от текущего момента. Если день есть, а времени нет — ставь 18:00. Если срока нет совсем — предложи реалистичный сам и скажи об этом в reply.
- Не ставь дедлайн в прошлое.
- Не предлагай «следующий шаг» и не советуй, с чего начать, — только если пользователь сам спросит.
- «сделал», «готово», «закрыл» → done по подходящей задаче из списка. «перенеси», «сдвинь» → update. Номера задач бери только из списка ниже. Если непонятно, о какой задаче речь, — спроси, действий не делай.
- «прочитал аср», «бомдод прочитан» → prayer. «истигфар 300» → istighfar с mode "set"; «ещё 100 истигфара» → mode "add". «прочитал Вакиа» → vakia.
- Если это вопрос или разговор, а не задача, — просто ответь в reply, actions пустой.
- reply: коротко, по делу, на «ты», по-русски. Если перечисляешь несколько пунктов — каждый с новой строки, между смысловыми блоками пустая строка; никаких сплошных простыней текста. Не пересказывай карточки — бот покажет их сам. Ты ментор: если задач слишком много, дедлайны нереальные или пользователь распыляется — скажи прямо.`;

const noReasoningFlag = new Set();
// Модель упёрлась в лимит (429) — не дёргаем её 30 минут, сразу идём к следующей
const COOL_MS = 30 * 60e3;
async function modelOrder(env) {
  const cool = await getMeta(env, 'llm_cool', {});
  const ready = LLM_MODELS.filter((m) => !(cool[m] > Date.now()));
  return ready.length ? ready : LLM_MODELS;
}
async function coolModel(env, model) {
  const cool = await getMeta(env, 'llm_cool', {});
  cool[model] = Date.now() + COOL_MS;
  await setMeta(env, 'llm_cool', cool);
}
async function llm(env, messages, jsonMode = true) {
  let last = new Error('LLM недоступна');
  for (const model of await modelOrder(env)) {
    try {
      const body = { model, messages, temperature: 0.3 };
      if (jsonMode) body.response_format = { type: 'json_object' };
      if (!noReasoningFlag.has(model)) body.reasoning_effort = 'low'; // меньше «раздумий» — быстрее ответ
      const call = () => fetch(LLM_BASE + '/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env.LLM_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      let r = await call();
      if (r.status === 400 && body.reasoning_effort) { // модель не принимает reasoning_effort — больше не шлём
        const t = await r.text();
        if (/reasoning/i.test(t)) { noReasoningFlag.add(model); delete body.reasoning_effort; r = await call(); }
        else r = new Response(t, { status: 400 });
      }
      if (!r.ok) { last = new Error('LLM ' + r.status); if (r.status === 429) await coolModel(env, model); if (r.status !== 404 && r.status !== 429 && r.status < 500) throw last; continue; }
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
    tasksText = tasksForPrompt(await cachedOpenTasks(env, cfg, schema));
  } catch (e) {
    tasksText = '(список задач недоступен: Notion не ответил)';
  }
  let groupsText = '';
  try { const gs = await activeGroups(env); groupsText = gs.length ? '\nГруппы, где есть бот: ' + gs.map((g) => '«' + g.title + '»').join(', ') + '.' : '\nБот пока не состоит ни в одной группе.'; } catch {}
  let timerText = '';
  try { timerText = '\n' + (await timerContext(env)); } catch {}
  return `Сейчас: ${n.replace('T', ' ')}, ${WEEKDAYS[d.getUTCDay()]} (Ташкент).\nСтатусы задач в Notion: ${statuses}.${groupsText}${timerText}\nОткрытые задачи:\n${tasksText}`;
}

// ---------- Обработка сообщений ----------
function welcome() {
  return 'Привет, я Джефф.\n\nПиши задачи как в обычный чат — я сформулирую, поставлю дедлайн и добавлю в Notion.\n' +
    'Например: «завтра до обеда отправить КП клиенту и созвониться с Азизом в четверг».\n\n' +
    '«Сделал КП» — закрою. «Перенеси созвон на пятницу» — перенесу. Правки, которые ты делаешь прямо в Notion, я тоже вижу.\n' +
    `Утром в ${MORNING} пришлю план, вечером в ${EVENING} — разбор дня. О дедлайнах напомню за час и в момент дедлайна.\n\n` +
    '🕌 В время намаза напомню и буду повторять каждые 10 минут, пока не отметишь.\n\n' +
    '⏱ «Начинаю #5 на 40 минут» или /go 5 40 — засеку время, за 5 минут напомню, итог запишу в Notion.\n🔕 Занят? /busy 2ч — отвечу людям в твоей личке и потом пришлю сводку (нужен Telegram Business).\n🎤 Можно присылать голосовые и 📷 фото (скрины переписки, записи) — сделаю из них задачи.\n\n/tasks — задачи, /notion — база в Notion, /namoz — молитвы, /istigfar 300 — истигфар за сегодня.';
}
// ---------- Фото и голосовые → текст (Gemini) ----------
const MEDIA_MAX = 19 * 1024 * 1024; // лимит скачивания у Telegram-ботов — 20 МБ
function pickMedia(msg) {
  if (msg.voice) return { kind: 'audio', file: msg.voice, mime: msg.voice.mime_type || 'audio/ogg' };
  if (msg.audio) return { kind: 'audio', file: msg.audio, mime: msg.audio.mime_type || 'audio/mpeg' };
  if (msg.video_note) return { kind: 'audio', file: msg.video_note, mime: 'video/mp4' };
  if (msg.photo && msg.photo.length) return { kind: 'image', file: msg.photo[msg.photo.length - 1], mime: 'image/jpeg' };
  const d = msg.document;
  if (d && /^(image|audio)\//.test(d.mime_type || '')) return { kind: d.mime_type.startsWith('image') ? 'image' : 'audio', file: d, mime: d.mime_type };
  return null;
}
function toBase64(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
async function mediaToText(env, m, caption) {
  if (m.file.file_size && m.file.file_size > MEDIA_MAX) throw new MediaError('Файл больше 20 МБ — Telegram не даёт ботам скачивать такие.');
  const f = await tg(env, 'getFile', { file_id: m.file.file_id });
  if (!f.ok || !f.result.file_path) throw new MediaError('Telegram не отдал файл.');
  const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${f.result.file_path}`);
  if (!r.ok) throw new MediaError('Не смог скачать файл из Telegram.');
  const data = toBase64(await r.arrayBuffer());
  const prompt = m.kind === 'audio'
    ? 'Это голосовое сообщение. Расшифруй его дословно, на том языке, на котором говорят (обычно русский; узбекский оставь узбекским). Исправь только очевидные ошибки распознавания. Верни только текст расшифровки, без пояснений. Если речи нет — верни пустую строку.'
    : 'Это фото, присланное в чат ассистента по задачам. Выпиши весь видимый текст (переписка, записи, списки) и коротко опиши, что на фото. Особенно отметь задачи, даты, время, имена, суммы, ссылки. Пиши по-русски, без вступлений.'
      + (caption ? '\nПодпись пользователя к фото: ' + caption : '');
  let last = new MediaError('Модель не смогла разобрать файл.');
  for (const model of await modelOrder(env)) {
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': env.LLM_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: m.mime, data } }] }], generationConfig: { temperature: 0.1 } }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) { if (resp.status === 429) await coolModel(env, model); console.log('media llm', model, resp.status, (await resp.text()).slice(0, 200)); continue; }
      const j = await resp.json();
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      return parts.map((p) => p.text || '').join('').trim();
    } catch (e) { console.log('media llm', model, String(e)); last = e instanceof MediaError ? e : last; }
  }
  throw last;
}
class MediaError extends Error {}

async function onMessage(env, msg) {
  if (msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) return onGroupMessage(env, msg);
  if (!msg.from || msg.chat.type !== 'private') return;
  const cfg = await getMeta(env, 'cfg', {});
  const uid = String(msg.from.id);
  if (!cfg.owner) {
    cfg.owner = uid; cfg.chat = msg.chat.id;
    await setMeta(env, 'cfg', cfg);
  }
  if (uid !== cfg.owner) return;
  if (cfg.chat !== msg.chat.id) { cfg.chat = msg.chat.id; await setMeta(env, 'cfg', cfg); }
  const chat = msg.chat.id;
  let text = (msg.text || '').trim();
  let heard = '';
  if (!text) {
    const media = pickMedia(msg);
    if (!media) return;
    await tg(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
    const caption = (msg.caption || '').trim();
    let got;
    try { got = await mediaToText(env, media, caption); } catch (e) {
      console.log('media failed', String(e));
      return send(env, chat, e instanceof MediaError ? e.message : 'Не смог разобрать файл — попробуй ещё раз.');
    }
    if (!got) return send(env, chat, media.kind === 'audio' ? 'Не расслышал слов в голосовом — попробуй ещё раз.' : 'Ничего не смог разобрать на фото.');
    if (media.kind === 'audio') { heard = got; text = got + (caption ? '\n' + caption : ''); }
    else text = (caption ? caption + '\n\n' : '') + '[Пользователь прислал фото. Что на нём:]\n' + got;
  }

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
  m = text.match(/^\/busy(?:@\w+)?\s*(.*)$/s);
  if (m) {
    if (/^ночь\s*(выкл|off|нет)/i.test(m[1])) { await setMeta(env, 'busy_night', false); return send(env, chat, 'Ночью больше не отвечаю за тебя. Включить: /busy ночь вкл'); }
    if (/^ночь\s*(вкл|on|да)/i.test(m[1])) { await setMeta(env, 'busy_night', true); return send(env, chat, 'Ночью (23:00–08:00) отвечаю за тебя и утром присылаю сводку.'); }
    return send(env, chat, await setBusy(env, parseBusyArg(m[1])));
  }
  m = text.match(/^\/go(?:@\w+)?\s*#?(\d+)?\s*(\d+)?/);
  if (m) {
    if (!m[1]) return send(env, chat, 'Укажи номер задачи: /go 5 или /go 5 40 (минут).');
    const r = await startTimer(env, Number(m[1]), m[2] ? Number(m[2]) : null);
    return send(env, chat, r.text, r.kb ? { reply_markup: r.kb } : undefined);
  }
  if (/^\/stop/.test(text)) return send(env, chat, await stopTimer(env, false));
  if (/^\/free/.test(text)) { const r = await setFree(env, chat); return r ? send(env, chat, r) : null; }
  if (text.startsWith('/')) return send(env, chat, 'Не знаю такой команды. Есть: /tasks, /notion, /namoz, /istigfar, /go, /stop, /busy, /free.');

  return chatWithJeff(env, chat, text, heard);
}

// Свободный текст → модель → действия. replyTo — чат для ответа (личка или группа).
async function chatWithJeff(env, replyTo, text, heard = '', extra = '') {
  const t0 = Date.now();
  const [, hist, header] = await Promise.all([
    tg(env, 'sendChatAction', { chat_id: replyTo, action: 'typing' }), getMeta(env, 'hist', []), contextHeader(env)]);
  const t1 = Date.now();
  let data;
  try {
    data = extractJson(await llm(env, [{ role: 'system', content: SYSTEM + '\n\n' + header + (extra ? '\n' + extra : '') }, ...hist, { role: 'user', content: text }]));
  } catch (e) {
    console.log('llm failed', String(e));
    return send(env, replyTo, 'Не смог обработать — модель не ответила. Попробуй ещё раз.');
  }
  const t2 = Date.now();
  const blocks = await applyActions(env, data.actions);
  const reply = String(data.reply || '').trim();
  hist.push({ role: 'user', content: text }, { role: 'assistant', content: reply || 'Готово.' });
  const t3 = Date.now();
  const perf = await getMeta(env, 'perf', []);
  perf.push({ at: nowLocal(), context_ms: t1 - t0, llm_ms: t2 - t1, actions_ms: t3 - t2, total_ms: t3 - t0 });
  await Promise.all([setMeta(env, 'hist', hist.slice(-12)), setMeta(env, 'perf', perf.slice(-10))]);
  const heardLine = heard ? '🎤 <i>' + esc(heard.length > 600 ? heard.slice(0, 600) + '…' : heard) + '</i>' : '';
  const body = [heardLine, ...blocks, reply ? esc(reply) : ''].filter(Boolean).join('\n\n');
  if (!body && (Array.isArray(data.actions) ? data.actions : []).some((a) => a && a.type === 'group_send')) return; // черновик уже показан
  return send(env, replyTo, body || 'Готово.');
}

// ---------- Группы ----------
const GROUP_KEEP = 300; // сколько последних сообщений хранить на группу
async function botUsername(env) {
  let u = await getMeta(env, 'bot_username', '');
  if (!u) { const me = await tg(env, 'getMe', {}); if (me.ok) { u = me.result.username; await setMeta(env, 'bot_username', u); } }
  return u;
}
async function upsertGroup(env, chat, active = 1) {
  await env.DB.prepare('INSERT INTO gchats (id, title, type, active, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type, active=excluded.active, updated=excluded.updated')
    .bind(chat.id, chat.title || 'Без названия', chat.type, active, nowLocal()).run();
}
async function activeGroups(env) {
  return ((await env.DB.prepare('SELECT id, title FROM gchats WHERE active=1 ORDER BY updated DESC').all()).results) || [];
}
function findGroup(groups, q) {
  q = String(q || '').toLowerCase().replace(/[«»"']/g, '').trim();
  if (!q) return null;
  const norm = (t) => String(t).toLowerCase();
  return groups.find((g) => norm(g.title) === q) || groups.find((g) => norm(g.title).includes(q)) ||
    groups.find((g) => q.split(/\s+/).filter((w) => w.length > 2).every((w) => norm(g.title).includes(w))) || null;
}
async function onGroupMessage(env, msg) {
  await upsertGroup(env, msg.chat, 1);
  const from = msg.from || {};
  const name = msg.sender_chat ? msg.sender_chat.title : [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '?';
  const text = (msg.text || msg.caption || '').trim() || (msg.voice ? '[голосовое]' : msg.photo ? '[фото]' : msg.document ? '[файл]' : msg.sticker ? '[стикер]' : '');
  if (text && !msg.new_chat_members && !msg.left_chat_member) {
    await env.DB.prepare('INSERT INTO gmsgs (chat, name, text, at) VALUES (?, ?, ?, ?)').bind(msg.chat.id, name, text.slice(0, 2000), nowLocal()).run();
    await env.DB.prepare('DELETE FROM gmsgs WHERE chat=? AND id <= (SELECT id FROM gmsgs WHERE chat=? ORDER BY id DESC LIMIT 1 OFFSET ?)').bind(msg.chat.id, msg.chat.id, GROUP_KEEP).run();
  }
  // в группе Джефф откликается только на владельца: упоминание, ответ на его сообщение или «Джефф, ...»
  const cfg = await getMeta(env, 'cfg', {});
  if (!cfg.owner || String(from.id) !== cfg.owner || !msg.text) return;
  const u = await botUsername(env);
  const mention = u && msg.text.toLowerCase().includes('@' + u.toLowerCase());
  const replyToBot = msg.reply_to_message && msg.reply_to_message.from && u && msg.reply_to_message.from.username === u;
  const byName = /^джефф[\s,:!]/i.test(msg.text);
  if (!mention && !replyToBot && !byName) return;
  const clean = msg.text.replace(new RegExp('@' + u, 'ig'), '').replace(/^джефф[\s,:!]+/i, '').trim();
  if (!clean) return send(env, msg.chat.id, 'Я тут 👋');
  const quoted = msg.reply_to_message && msg.reply_to_message.text ? `\nПользователь отвечает на сообщение: «${msg.reply_to_message.text.slice(0, 1000)}»` : '';
  return chatWithJeff(env, msg.chat.id, clean, '', `Сейчас пользователь пишет тебе в группе «${msg.chat.title}». Ответ увидят все участники — пиши уместно.${quoted}`);
}
async function onMyChatMember(env, u) {
  if (!u.chat || u.chat.type === 'private') return;
  const st = u.new_chat_member && u.new_chat_member.status;
  const active = ['member', 'administrator', 'creator', 'restricted'].includes(st) ? 1 : 0;
  await upsertGroup(env, u.chat, active);
  const cfg = await getMeta(env, 'cfg', {});
  if (cfg.chat) await send(env, cfg.chat, active
    ? `👥 Меня добавили в группу «${esc(u.chat.title || '')}». Теперь читаю её и могу писать туда по твоей команде.`
    : `👋 Меня убрали из группы «${esc(u.chat.title || '')}».`);
}
async function groupDigest(env, groupQuery, limit) {
  const groups = await activeGroups(env);
  if (!groups.length) return 'Я пока не состою ни в одной группе. Добавь меня в группу (как обычного участника) — и смогу читать и писать там.';
  let rows, title;
  if (groupQuery) {
    const g = findGroup(groups, groupQuery);
    if (!g) return `Не нашёл группу «${groupQuery}». Я есть в: ${groups.map((x) => '«' + x.title + '»').join(', ')}.`;
    title = g.title;
    rows = ((await env.DB.prepare('SELECT * FROM gmsgs WHERE chat=? ORDER BY id DESC LIMIT ?').bind(g.id, Math.min(Number(limit) || 60, GROUP_KEEP)).all()).results || []).reverse();
  } else {
    const since = nowLocal(Date.now() - 24 * 3600e3);
    rows = (await env.DB.prepare('SELECT m.*, g.title FROM gmsgs m JOIN gchats g ON g.id=m.chat WHERE g.active=1 AND m.at >= ? ORDER BY m.id DESC LIMIT 300').bind(since).all()).results || [];
    rows.reverse();
  }
  if (!rows.length) return title ? `В «${title}» пока нет сообщений с тех пор, как я там.` : 'За сутки в группах ничего не писали.';
  const raw = rows.map((r) => `${r.title ? '[' + r.title + '] ' : ''}${r.at.slice(5, 16).replace('T', ' ')} ${r.name}: ${r.text}`).join('\n');
  try {
    const sum = await llm(env, [
      { role: 'system', content: 'Ты — Джефф, ассистент предпринимателя. Сделай короткую сводку переписки в Telegram-группе по-русски: о чём говорили, кто что просил или обещал, что требует его реакции. Если уместно — строка «Задачи:» в конце. Без markdown.' },
      { role: 'user', content: raw.slice(-14000) }], false);
    return `👥 ${title ? '«' + title + '»' : 'Группы за сутки'}:\n${String(sum).trim()}`;
  } catch { return `👥 ${title ? '«' + title + '»' : 'Группы за сутки'} — последние сообщения:\n` + raw.slice(-3000); }
}
async function draftGroupMessage(env, groupQuery, text) {
  const groups = await activeGroups(env);
  const g = findGroup(groups, groupQuery);
  if (!g) return groups.length ? `Не нашёл группу «${groupQuery}». Я есть в: ${groups.map((x) => '«' + x.title + '»').join(', ')}.` : 'Я пока не состою ни в одной группе — добавь меня туда.';
  text = String(text || '').trim();
  if (!text) return 'Что написать в группу?';
  const id = Date.now().toString(36);
  await setMeta(env, 'gdraft:' + id, { chat: g.id, title: g.title, text });
  const cfg = await getMeta(env, 'cfg', {});
  await send(env, cfg.chat, `✉️ Отправить в «${esc(g.title)}»?\n\n${esc(text)}`, { reply_markup: { inline_keyboard: [[{ text: '✅ Отправить', callback_data: 'g:' + id }, { text: '✖️ Отмена', callback_data: 'gx:' + id }]] } });
  return '';
}

async function onCallback(env, cq) {
  const cfg = await getMeta(env, 'cfg', {});
  if (!cfg.owner || String(cq.from.id) !== cfg.owner) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const data = cq.data || '';
  const msg = cq.message;
  let note = '';
  if (/^(tx:\d+|ts|td)$/.test(data)) {
    const r = data === 'ts' ? await stopTimer(env, false) : data === 'td' ? await stopTimer(env, true) : await extendTimer(env, Number(data.split(':')[1]));
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    if (msg) await tg(env, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
    return send(env, cq.from.id, r, data.startsWith('tx') ? { reply_markup: timerKb } : undefined);
  }
  let g = data.match(/^(g|gx):(\w+)$/);
  if (g) {
    const d = await getMeta(env, 'gdraft:' + g[2], null);
    if (!d) { await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Черновик устарел' }); return; }
    await env.DB.prepare('DELETE FROM meta WHERE k=?').bind('gdraft:' + g[2]).run();
    let result = '✖️ Отменено.';
    if (g[1] === 'g') {
      const r = await tg(env, 'sendMessage', { chat_id: d.chat, text: d.text });
      result = r.ok ? `✅ Отправлено в «${esc(d.title)}»:\n\n${esc(d.text)}` : `Не получилось отправить в «${esc(d.title)}»: ${esc(r.description || 'ошибка')}`;
    }
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    if (msg) await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: result, parse_mode: 'HTML' });
    return;
  }
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
  if (sch.sunrise && !pings.sunrise && hm >= addMin(sch.sunrise, -SUNRISE_BEFORE_MIN) && hm < sch.sunrise) {
    const [sh, sm] = sch.sunrise.split(':').map(Number), [nh, nm] = hm.split(':').map(Number);
    const left = sh * 60 + sm - nh * 60 - nm;
    const bomdodOpen = !day.prayers.bomdod;
    const r = await send(env, chat, `🌅 Восход в <b>${sch.sunrise}</b> — через ${left} мин.` + (bomdodOpen ? '\nБомдод ещё не отмечен — успей до восхода.' : ''),
      bomdodOpen ? { reply_markup: { inline_keyboard: [[{ text: '✅ Бомдод прочитан', callback_data: `p:${date}:bomdod` }]] } } : undefined);
    await env.DB.prepare('INSERT OR IGNORE INTO pings (date, key, last, msg) VALUES (?, ?, ?, ?)').bind(date, 'sunrise', nowSec, r.ok ? r.result.message_id : null).run();
  }
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
      { role: 'system', content: 'Ты — Джефф, ментор предпринимателя. Пиши коротко, прямо, на «ты», по-русски, обычным текстом без разметки. Ссылайся на задачи по номерам. Структурируй: каждая задача — отдельный абзац вида «#5 Название — почему важно / что сделать», между абзацами пустая строка; короткие заголовки блоков с эмодзи (например «🔥 Главное сегодня», «🔴 Просрочено»). Без сплошного текста.\n\n' + (await contextHeader(env)) },
      { role: 'user', content: ask }], false);
  } catch { text = null; }
  if (text && mode === 'evening') {
    const t = await daySchedule(env, addDaysStr(date, 1)).catch(() => null);
    if (t && t.sunrise) text += `\n\n🌅 Завтра: Бомдод ${t.list[0].time}, восход ${t.sunrise}.`;
  }
  if (text) await tg(env, 'sendMessage', { chat_id: chat, text });
}
// ---------- Колонки канбана: Список → Задачи на неделю → Завтра → Сегодня ----------
const COL = { list: /^список/i, week: /недел/i, tomorrow: /^завтра/i, today: /^сегодня/i };
const COL_RANK = ['list', 'week', 'tomorrow', 'today'];
const colOf = (schema, key) => schema.statuses.find((s) => COL[key].test(s)) || null;
const colKey = (status) => COL_RANK.find((k) => COL[k].test(status || '')) || null;
function addDaysStr(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
function weekEndStr(d) { return addDaysStr(d, (7 - new Date(d + 'T00:00:00Z').getUTCDay()) % 7); } // ближайшее воскресенье
function autoColumnKey(deadline, now) {
  if (!deadline) return null;
  const d = String(deadline).slice(0, 10);
  if (d <= now) return 'today';
  if (d === addDaysStr(now, 1)) return 'tomorrow';
  if (d <= weekEndStr(now)) return 'week';
  return 'list';
}
const autoColumn = (schema, deadline, now = today()) => { const k = autoColumnKey(deadline, now); return k ? colOf(schema, k) : null; };
// Раз в день двигаем задачи ближе к «Сегодня» по дедлайну; вчерашнее «Завтра» становится «Сегодня». Назад не двигаем.
async function cronColumns(env) {
  const day = today();
  if ((await getMeta(env, 'col_day', '')) === day) return;
  const { cfg, schema } = await taskCtx(env);
  await setMeta(env, 'col_day', day);
  const prev = await getMeta(env, 'col_prev_day', day);
  await setMeta(env, 'col_prev_day', day);
  for (const t of await openTasks(env, cfg, schema)) {
    const cur = colKey(t.status);
    if (!cur) continue; // свои колонки пользователя не трогаем
    let target = autoColumnKey(t.deadline, day);
    if (cur === 'tomorrow' && prev < day && !target) target = 'today';
    if (target && COL_RANK.indexOf(target) > COL_RANK.indexOf(cur)) {
      const name = colOf(schema, target);
      if (name) { try { await updateTask(env, schema, t.page, { status: name }); } catch (e) { console.log('col move', String(e)); } }
    }
  }
}

// ---------- Режим «Занят»: Джефф отвечает в личке владельца через Telegram Business ----------
const NIGHT_FROM = 23, NIGHT_TO = 8; // ночью тоже «занят»
const BUSY_REPLY = 'Здравствуйте! Иззатбек сейчас занят и ответит чуть позже.\nAssalomu alaykum! Izzatbek hozir band, birozdan keyin javob beradi.';
const URGENT_RE = /срочн|urgent|asap|tez\b|tezda|shoshilinch/i;
const localToMs = (s) => Date.parse(s + ':00Z') - TZ_MIN * 60000;
async function busyState(env, now = Date.now()) {
  const b = await getMeta(env, 'busy', {});
  if (b.on && (!b.until || b.until > now)) return { mode: 'manual', period: 'm' + b.since, until: b.until || null };
  const night = await getMeta(env, 'busy_night', true);
  const h = Number(nowLocal(now).slice(11, 13));
  if (night && (h >= NIGHT_FROM || h < NIGHT_TO)) {
    const start = h >= NIGHT_FROM ? today(now) : addDaysStr(today(now), -1);
    return { mode: 'night', period: 'n' + start, until: null };
  }
  return null;
}
function parseBusyArg(arg, now = Date.now()) {
  arg = String(arg || '').trim().toLowerCase();
  if (!arg) return null;
  let m = arg.match(/до\s*(\d{1,2})(?:[:.](\d{2}))?/);
  if (m) {
    let t = localToMs(today(now) + 'T' + String(Math.min(23, +m[1])).padStart(2, '0') + ':' + (m[2] || '00'));
    if (t <= now) t += 864e5;
    return t;
  }
  let ms = 0;
  if ((m = arg.match(/(\d+(?:[.,]\d+)?)\s*(ч|h|час)/))) ms += parseFloat(m[1].replace(',', '.')) * 3600e3;
  if ((m = arg.match(/(\d+)\s*(м|min|мин)/))) ms += +m[1] * 60e3;
  if (!ms && (m = arg.match(/^(\d+(?:[.,]\d+)?)$/))) ms = parseFloat(m[1].replace(',', '.')) * 3600e3;
  return ms ? now + ms : null;
}
const hm = (ms) => nowLocal(ms).slice(11, 16);
async function setBusy(env, until) {
  await setMeta(env, 'busy', { on: true, since: Date.now(), until: until || null });
  const biz = await getMeta(env, 'biz', {});
  return '🔕 Режим «Занят» включён' + (until ? ` до ${hm(until)}` : ' — выключить: /free') + '.\n' +
    (biz.enabled ? 'Отвечу людям в личке, что ты занят, а потом пришлю сводку.' : 'Чтобы я отвечал людям в твоей личке, подключи меня: Настройки → Telegram Business → Чат-боты → @' + (biz.bot || 'jeff_aliev_bot') + '.');
}
async function setFree(env, chat) {
  await setMeta(env, 'busy', { on: false });
  const sent = await flushBizDigest(env, chat, true);
  return sent ? '' : '🔔 Режим «Занят» выключен. Пока тебя не было, никто не писал.';
}
async function onBusinessConnection(env, bc) {
  const cfg = await getMeta(env, 'cfg', {});
  if (!cfg.owner || String(bc.user.id) !== cfg.owner) return; // отвечать можно только за владельца
  const canReply = !!(bc.rights ? bc.rights.can_reply : bc.can_reply);
  await setMeta(env, 'biz', { id: bc.id, enabled: !!bc.is_enabled, can_reply: canReply });
  if (cfg.chat) await send(env, cfg.chat, bc.is_enabled
    ? (canReply ? '🤝 Подключился к твоему Telegram. Когда ты занят (/busy) или ночью (23:00–08:00), отвечу людям в личке и потом пришлю сводку.'
      : '🤝 Подключился, но без права отвечать. Включи «Отвечать на сообщения» в Настройки → Telegram Business → Чат-боты.')
    : 'Отключился от твоего Telegram — в личке больше не отвечаю.');
}
async function onBusinessMessage(env, msg) {
  const cfg = await getMeta(env, 'cfg', {});
  const biz = await getMeta(env, 'biz', {});
  if (!cfg.owner || !biz.enabled || msg.business_connection_id !== biz.id) return;
  if (!msg.chat || msg.chat.type !== 'private') return;
  const st = await busyState(env);
  if (!msg.from || String(msg.from.id) === cfg.owner) { // ты сам написал в этом чате — дальше не встреваю
    if (st) await env.DB.prepare('INSERT OR IGNORE INTO bizdone (chat, period) VALUES (?, ?)').bind(msg.chat.id, st.period).run();
    return;
  }
  if (msg.from.is_bot || !st) return;
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Без имени';
  const text = (msg.text || msg.caption || '').trim() || (msg.voice ? '[голосовое]' : msg.photo ? '[фото]' : msg.sticker ? '[стикер]' : '[вложение]');
  await env.DB.prepare('INSERT INTO bizq (chat, name, username, text, at) VALUES (?, ?, ?, ?, ?)')
    .bind(msg.chat.id, name, msg.from.username || '', text.slice(0, 1500), nowLocal()).run();
  const done = await env.DB.prepare('SELECT 1 FROM bizdone WHERE chat=? AND period=?').bind(msg.chat.id, st.period).first();
  if (!done && biz.can_reply) {
    const r = await tg(env, 'sendMessage', { business_connection_id: biz.id, chat_id: msg.chat.id, text: BUSY_REPLY });
    if (r.ok) await env.DB.prepare('INSERT OR IGNORE INTO bizdone (chat, period) VALUES (?, ?)').bind(msg.chat.id, st.period).run();
  }
  if (URGENT_RE.test(text) && cfg.chat) {
    await send(env, cfg.chat, `🔴 Срочное от <b>${esc(name)}</b>${msg.from.username ? ' @' + esc(msg.from.username) : ''}:\n${esc(text.slice(0, 500))}`);
  }
}
async function flushBizDigest(env, chat, force = false) {
  if (!force && (await busyState(env))) return false;
  const { results } = await env.DB.prepare('SELECT * FROM bizq ORDER BY id').all();
  if (!results || !results.length) return false;
  const ids = results.map((r) => r.id);
  const people = new Map();
  for (const r of results) {
    const p = people.get(r.chat) || { name: r.name, username: r.username, msgs: [] };
    p.msgs.push(`[${r.at.slice(11, 16)}] ${r.text}`); people.set(r.chat, p);
  }
  const raw = [...people.values()].map((p) => `${p.name}${p.username ? ' (@' + p.username + ')' : ''}:\n` + p.msgs.join('\n')).join('\n\n');
  let summary = '';
  try {
    summary = String(await llm(env, [
      { role: 'system', content: 'Ты — Джефф, ассистент предпринимателя. Пока он был занят, ему написали в Telegram. Сделай короткую сводку по-русски: по каждому человеку одна-две строки — кто, чего хочет, что ответить и насколько срочно. В конце, если уместно, строка «Задачи:» со списком, что стоит сделать. Без markdown, без вступлений.' },
      { role: 'user', content: raw.slice(0, 12000) }], false)).trim();
  } catch (e) { console.log('biz digest llm', String(e)); }
  const head = `📬 Пока ты был занят, написали: ${people.size} ${people.size === 1 ? 'человек' : people.size < 5 ? 'человека' : 'человек'}.\n\n`;
  const body = esc(summary || raw);
  await send(env, chat, (head + body).slice(0, 4000));
  await env.DB.prepare(`DELETE FROM bizq WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  await env.DB.prepare('DELETE FROM bizdone WHERE period NOT IN (?)').bind((await busyState(env) || {}).period || '-').run();
  return true;
}
async function cronBusy(env, chat) {
  const b = await getMeta(env, 'busy', {});
  if (b.on && b.until && b.until <= Date.now()) await setMeta(env, 'busy', { on: false });
  await flushBizDigest(env, chat);
}

// ---------- Таймер задач ----------
const WARN_BEFORE_MIN = 5;
function fmtMin(m) { m = Math.round(m || 0); return m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ' ' + (m % 60) + ' мин' : ''}` : `${m} мин`; }
const timerKb = { inline_keyboard: [[{ text: '+15 мин', callback_data: 'tx:15' }, { text: '⏹ Стоп', callback_data: 'ts' }, { text: '✅ Готово', callback_data: 'td' }]] };
const activeTimer = (env) => env.DB.prepare('SELECT * FROM timers WHERE active=1 ORDER BY id DESC LIMIT 1').first();
async function stopTimer(env, done = false) {
  const t = await activeTimer(env);
  if (!t) return 'Сейчас таймер не запущен. Начать: «начинаю #5 на 30 минут» или /go 5 30.';
  const mins = Math.max(1, Math.round((Date.now() - t.started) / 60000));
  await env.DB.prepare('UPDATE timers SET active=0 WHERE id=?').bind(t.id).run();
  let total = mins, note = '';
  try {
    const { schema } = await taskCtx(env);
    const task = await taskByNum(env, t.num);
    total = ((task && task.spent) || 0) + mins;
    const f = { spent: total };
    if (done) f.status = doneStatusOf(schema);
    await updateTask(env, schema, t.page, f);
  } catch (e) { console.log('timer notion', String(e)); note = '\n⚠️ В Notion записать не получилось: ' + esc(setupHint(e)); }
  const diff = mins - t.budget;
  const verdict = diff > 0 ? `на ${fmtMin(diff)} дольше плана` : diff < 0 ? `на ${fmtMin(-diff)} быстрее плана 💪` : 'ровно по плану';
  return `${done ? '🏁 Закрыта' : '⏹ Остановил'} #${t.num}: <b>${esc(t.title)}</b>\n⏱ Потрачено ${fmtMin(mins)} из ${fmtMin(t.budget)} — ${verdict}.\nВсего на задачу: ${fmtMin(total)} (записал в Notion).` + note;
}
async function startTimer(env, num, minutes) {
  const task = await taskByNum(env, num);
  if (!task) return { text: `Задачи #${num} не нашёл среди открытых.` };
  let prev = '';
  const cur = await activeTimer(env);
  if (cur) prev = (await stopTimer(env, false)) + '\n\n';
  const budget = Math.max(1, Math.min(600, Math.round(Number(minutes) || task.planned || 30)));
  await env.DB.prepare('INSERT INTO timers (page, num, title, started, budget) VALUES (?, ?, ?, ?, ?)').bind(task.page, task.id, task.title, Date.now(), budget).run();
  try { const { schema } = await taskCtx(env); if (task.planned !== budget) await updateTask(env, schema, task.page, { planned: budget }); } catch (e) { console.log('timer plan', String(e)); }
  const end = nowLocal(Date.now() + budget * 60000).slice(11, 16);
  return { text: prev + `▶️ Засёк: #${task.id} <b>${esc(task.title)}</b>\n⏱ ${fmtMin(budget)} — закончить к ${end}. За ${WARN_BEFORE_MIN} минут напомню.` + (task.spent ? `\nРаньше уже потрачено: ${fmtMin(task.spent)}.` : ''), kb: timerKb };
}
async function extendTimer(env, minutes) {
  const t = await activeTimer(env);
  if (!t) return 'Сейчас таймер не запущен.';
  const add = Math.max(1, Math.round(Number(minutes) || 15));
  const budget = t.budget + add;
  await env.DB.prepare('UPDATE timers SET budget=?, warned=0, over=0 WHERE id=?').bind(budget, t.id).run();
  try { const { schema } = await taskCtx(env); await updateTask(env, schema, t.page, { planned: budget }); } catch (e) { console.log('timer extend', String(e)); }
  return `➕ Добавил ${fmtMin(add)} на #${t.num}. Теперь закончить к ${nowLocal(t.started + budget * 60000).slice(11, 16)}.`;
}
async function cronTimers(env, chat) {
  const t = await activeTimer(env);
  if (!t) return;
  const left = t.started + t.budget * 60000 - Date.now();
  if (left <= 0 && !t.over) {
    await send(env, chat, `⌛️ Время на #${t.num} <b>${esc(t.title)}</b> вышло (${fmtMin(t.budget)}).\nЗакончил, или добавить времени?`, { reply_markup: timerKb });
    await env.DB.prepare('UPDATE timers SET over=1, warned=1 WHERE id=?').bind(t.id).run();
  } else if (left > 0 && left <= WARN_BEFORE_MIN * 60000 + 30000 && !t.warned) {
    await send(env, chat, `⏳ Осталось ${Math.max(1, Math.round(left / 60000))} мин на #${t.num} <b>${esc(t.title)}</b>.`, { reply_markup: timerKb });
    await env.DB.prepare('UPDATE timers SET warned=1 WHERE id=?').bind(t.id).run();
  }
}
async function timerContext(env) {
  const t = await activeTimer(env);
  if (!t) return 'Таймер сейчас не запущен.';
  const spent = Math.round((Date.now() - t.started) / 60000);
  return `Сейчас идёт таймер: #${t.num} «${t.title}», прошло ${spent} мин из ${t.budget}.`;
}

// ---------- Самопроверка: живьём дёргает каждую часть ----------
async function healthCheck(env) {
  await ensureSchema(env);
  const out = {}, t = async (name, fn) => {
    const s = Date.now();
    try { out[name] = { ok: true, ...(await fn()), ms: Date.now() - s }; } catch (e) { out[name] = { ok: false, error: String(e && e.message || e).slice(0, 200), ms: Date.now() - s }; }
  };
  await t('telegram', async () => {
    const [me, w] = await Promise.all([tg(env, 'getMe', {}), tg(env, 'getWebhookInfo', {})]);
    if (!me.ok) throw new Error(me.description || 'getMe failed');
    const r = w.result || {};
    if (!r.url) throw new Error('вебхук не установлен');
    return { bot: me.result.username, webhook: r.url, pending: r.pending_update_count, lastError: r.last_error_message || null,
      updates: r.allowed_updates || [] };
  });
  await t('cron', async () => {
    const last = await getMeta(env, 'cron_at', 0);
    const ago = Math.round((Date.now() - last) / 1000);
    if (!last || ago > 180) throw new Error(`расписание не тикало ${last ? ago + ' с' : 'ни разу'}`);
    return { lastTickSecAgo: ago };
  });
  await t('notion', async () => {
    const { cfg, schema } = await taskCtx(env);
    const src = await notion(env, 'GET', '/data_sources/' + cfg.ds);
    const cols = Object.keys(src.properties || {});
    const need = Object.values(P).filter((k) => !cols.includes(k));
    if (need.length) throw new Error('нет колонок: ' + need.join(', '));
    const tasks = await openTasks(env, cfg, schema);
    return { statuses: schema.statuses, openTasks: tasks.length, url: cfg.url };
  });
  await t('gemini', async () => {
    const models = {};
    await Promise.all(LLM_MODELS.flatMap((model) => ['low', null].map(async (effort) => {
      const s = Date.now();
      try {
        const body = { model, messages: [{ role: 'user', content: 'Ответь одним словом: ок' }], temperature: 0.3 };
        if (effort) body.reasoning_effort = effort;
        const r = await fetch(LLM_BASE + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + env.LLM_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
        const txt = await r.text();
        models[model + (effort ? ' [low]' : ' [default]')] = { status: r.status, ms: Date.now() - s, note: r.ok ? '' : txt.slice(0, 160) };
      } catch (e) { models[model + (effort ? ' [low]' : ' [default]')] = { status: 0, ms: Date.now() - s, note: String(e).slice(0, 120) }; }
    })));
    if (!Object.values(models).some((m) => m.status === 200)) throw new Error('ни одна модель не ответила: ' + JSON.stringify(models));
    return { models };
  });
  await t('prayers', async () => {
    const sch = await daySchedule(env, today());
    if (!sch) throw new Error('время намазов не загрузилось');
    return { source: sch.source, sunrise: sch.sunrise, times: Object.fromEntries(sch.list.map((p) => [p.name, p.time])) };
  });
  await t('owner', async () => { const c = await getMeta(env, 'cfg', {}); if (!c.owner) throw new Error('хозяин не назначен'); return { chatSet: !!c.chat }; });
  await t('business', async () => {
    const b = await getMeta(env, 'biz', {});
    if (!b.id) throw new Error('Telegram Business не подключён');
    const st = await busyState(env);
    return { enabled: !!b.enabled, canReply: !!b.can_reply, busyNow: st ? st.mode : false, nightMode: await getMeta(env, 'busy_night', true),
      queued: (await env.DB.prepare('SELECT COUNT(*) AS n FROM bizq').first()).n };
  });
  await t('groups', async () => ({ groups: (await activeGroups(env)).map((g) => g.title) }));
  await t('timer', async () => { const a = await activeTimer(env); return { active: a ? `#${a.num} ${a.title}, ${Math.round((Date.now() - a.started) / 60000)}/${a.budget} мин` : null }; });
  await t('media', async () => ({ note: 'голос/фото идут через тот же ключ Gemini', keyPresent: !!env.LLM_API_KEY }));
  out.allOk = Object.values(out).every((x) => x.ok);
  out.now = nowLocal();
  return out;
}

async function cronTick(env, ctx) {
  const last = await getMeta(env, 'cron_at', 0);
  if (Date.now() - last < 45000) return false;
  await setMeta(env, 'cron_at', Date.now());
  ctx.waitUntil(runCron(env));
  return true;
}
async function runCron(env) {
  await ensureSchema(env);
  const cfg = await getMeta(env, 'cfg', {});
  if (!cfg.chat) return;
  for (const job of [() => cronPrayers(env, cfg.chat), () => cronTimers(env, cfg.chat), () => cronBusy(env, cfg.chat), () => cronColumns(env), () => cronDeadlines(env, cfg.chat), () => cronDigest(env, cfg.chat)]) {
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
  else { out.bot = me.result.username; if (out.bot) await setMeta(env, 'bot_username', out.bot); }
  out.webhook = (await tg(env, 'setWebhook', { url: origin + '/tg', secret_token: await webhookSecret(env), allowed_updates: ['message', 'callback_query', 'business_connection', 'business_message', 'my_chat_member'], drop_pending_updates: false })).ok;
  out.menu = (await tg(env, 'setChatMenuButton', { menu_button: { type: 'commands' } })).ok;
  out.commands = (await tg(env, 'setMyCommands', { commands: [
    { command: 'tasks', description: 'Открытые задачи' }, { command: 'notion', description: 'База задач в Notion' },
    { command: 'namoz', description: 'Молитвы на сегодня' }, { command: 'istigfar', description: 'Истигфар за сегодня: /istigfar 300' },
    { command: 'go', description: 'Начать задачу с таймером: /go 5 40' }, { command: 'stop', description: 'Остановить таймер и записать время' },
    { command: 'busy', description: 'Я занят: /busy 2ч или /busy до 18:00' }, { command: 'free', description: 'Я свободен — сводка, кто писал' }] })).ok;
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
        if (!env.NO_WEBHOOK_TICK) ctx.waitUntil(ensureSchema(env).then(() => cronTick(env, ctx)).catch(() => {})); // страховка, если внешний будильник молчит
        ctx.waitUntil((async () => {
          try {
            await ensureSchema(env);
            if (update.message) await onMessage(env, update.message);
            else if (update.business_connection) await onBusinessConnection(env, update.business_connection);
            else if (update.business_message) await onBusinessMessage(env, update.business_message);
            else if (update.my_chat_member) await onMyChatMember(env, update.my_chat_member);
            else if (update.callback_query) await onCallback(env, update.callback_query);
          } catch (e) {
            console.log('update failed', String(e && e.stack || e));
            try { await setMeta(env, 'last_error', { at: nowLocal(), error: String(e && e.message || e).slice(0, 300) }); } catch (_) {}
          }
        })());
        return new Response('ok');
      }
      if (path === '/health') return json(await healthCheck(env));
      if (path === '/status') {
        await ensureSchema(env);
        const w = await tg(env, 'getWebhookInfo', {});
        const cfg = await getMeta(env, 'cfg', {});
        const r = w.result || {};
        return json({ webhookUrl: r.url || null, pending: r.pending_update_count, telegramLastError: r.last_error_message || null,
          telegramLastErrorAt: r.last_error_date ? new Date(r.last_error_date * 1000).toISOString() : null,
          ownerSet: !!cfg.owner, lastError: await getMeta(env, 'last_error', null), perf: await getMeta(env, 'perf', []), now: nowLocal() });
      }
      if (path === '/setup') return json(await setup(env, url.origin + '/jeff'));
      if (path === '/cron') { // тик расписания; не чаще раза в 45 секунд, кто бы ни вызвал
        await ensureSchema(env);
        return new Response((await cronTick(env, ctx)) ? 'ok' : 'skip');
      }
      return new Response('Джефф на связи.', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } catch (e) {
      console.log('fetch failed', String(e && e.stack || e));
      return json({ error: 'server error' }, 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runCron(cleanEnv(env))); },
};
