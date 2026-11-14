// Джефф — Telegram-бот на Cloudflare Workers: задачи, дедлайны, намазы, истигфар.
// Привязки: DB (D1). Секреты: TELEGRAM_TOKEN, LLM_API_KEY.

const TZ_MIN = 300; // Asia/Tashkent, UTC+5, без перевода часов
const APP_URL = 'https://besoft.uz/task/';
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
const DEFAULT_COLUMNS = [
  { id: 'new', name: 'Новые', done: false }, { id: 'work', name: 'В работе', done: false },
  { id: 'review', name: 'На проверке', done: false }, { id: 'done', name: 'Готово', done: true },
];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const ORIGINS = [/^https:\/\/(www\.)?besoft\.uz$/, /^https:\/\/([a-z0-9-]+\.)?besoft\.pages\.dev$/];

// ---------- Время ----------
const pad = (n) => String(n).padStart(2, '0');
function nowLocal(ts = Date.now()) { return new Date(ts + TZ_MIN * 60000).toISOString().slice(0, 16); } // YYYY-MM-DDTHH:MM
function today(ts) { return nowLocal(ts).slice(0, 10); }
function addDays(date, n) { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function localToTs(local) { return Date.parse(local + ':00Z') - TZ_MIN * 60000; }
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
function human(local) {
  if (!local) return 'без дедлайна';
  const d = new Date(local + ':00Z');
  return `${WEEKDAYS[d.getUTCDay()]}, ${local.slice(8, 10)}.${local.slice(5, 7)}.${local.slice(0, 4)} ${local.slice(11, 16)}`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- База ----------
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, project TEXT, next_step TEXT,
    deadline TEXT, created TEXT NOT NULL, status TEXT NOT NULL, pos REAL NOT NULL DEFAULT 0, reminded INTEGER NOT NULL DEFAULT 0, done_at TEXT)`,
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
async function getColumns(env) {
  const c = await getMeta(env, 'columns');
  return Array.isArray(c) && c.length ? c : DEFAULT_COLUMNS;
}
const doneIds = (cols) => cols.filter((c) => c.done).map((c) => c.id);
async function allTasks(env) {
  return (await env.DB.prepare('SELECT * FROM tasks ORDER BY pos, id').all()).results || [];
}
async function getTask(env, id) { return env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(Number(id)).first(); }
async function nextPos(env) {
  const r = await env.DB.prepare('SELECT MAX(pos) AS m FROM tasks').first();
  return ((r && r.m) || 0) + 1;
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
const send = (env, chat, text, extra) => tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', ...(extra || {}) });
async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const webhookSecret = async (env) => (await sha256hex('webhook:' + env.TELEGRAM_TOKEN)).slice(0, 48);
async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
// Проверка подписи Telegram Mini App: возвращает id пользователя или null
async function verifyInitData(env, initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = await hmac(new TextEncoder().encode('WebAppData'), env.TELEGRAM_TOKEN);
    const sig = [...(await hmac(secret, check))].map((x) => x.toString(16).padStart(2, '0')).join('');
    if (sig.length !== hash.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ hash.charCodeAt(i);
    if (diff) return null;
    if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 7 * 86400) return null;
    return String(JSON.parse(p.get('user') || '{}').id || '') || null;
  } catch { return null; }
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
// Расписание дня: [{key, name, time, end}] в местном времени HH:MM
async function daySchedule(env, date) {
  const m = await monthTimes(env, date.slice(0, 7));
  const t = m && m.days[date];
  if (!t) return null;
  const vitr = addMin(t.xufton, VITR_AFTER_MIN);
  return {
    source: m.source, sunrise: t.quyosh,
    list: [
      { key: 'bomdod', name: 'Бомдод', time: t.bomdod, end: t.quyosh },
      { key: 'peshin', name: 'Пешин', time: t.peshin, end: t.asr },
      { key: 'asr', name: 'Аср', time: t.asr, end: t.shom },
      { key: 'shom', name: 'Шом', time: t.shom, end: t.xufton },
      { key: 'xufton', name: 'Хуфтон', time: t.xufton, end: '23:59' },
      { key: 'vitr', name: 'Витр', time: vitr, end: '23:59' },
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
  const rows = [];
  for (let i = 0; i < kb.length; i += 3) rows.push(kb.slice(i, i + 3));
  rows.push([{ text: day.vakia ? '↩️ Аль-Вакиа не прочитана' : '✅ Аль-Вакиа прочитана', callback_data: `v:${date}` }]);
  rows.push([{ text: 'Открыть трекер', web_app: { url: APP_URL } }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// ---------- Задачи ----------
function taskCard(t, cols, head = '✅ Задача') {
  const c = cols.find((x) => x.id === t.status);
  const lines = [`${head} #${t.id}`, `<b>${esc(t.title)}</b>`, `⏰ Дедлайн: ${human(t.deadline)}`];
  if (t.project) lines.push(`📁 Проект: ${esc(t.project)}`);
  if (c) lines.push(`📌 Статус: ${esc(c.name)}`);
  if (t.next_step) lines.push(`👉 Следующий шаг: ${esc(t.next_step)}`);
  lines.push(`🕒 Поставлена: ${human(t.created)}`);
  return lines.join('\n');
}
async function openTasks(env, cols) {
  const done = doneIds(cols);
  return (await allTasks(env)).filter((t) => !done.includes(t.status))
    .sort((a, b) => (!a.deadline) - (!b.deadline) || String(a.deadline).localeCompare(String(b.deadline)) || a.id - b.id);
}
async function listText(env, cols) {
  const rows = await openTasks(env, cols);
  if (!rows.length) return 'Открытых задач нет.';
  const now = nowLocal();
  return '📋 <b>Открытые задачи</b>\n' + rows.map((t) =>
    `#${t.id} ${esc(t.title)}${t.project ? ` [${esc(t.project)}]` : ''} — ${human(t.deadline)}${t.deadline && t.deadline < now ? ' 🔴 просрочено' : ''}`).join('\n');
}
async function tasksForPrompt(env, cols) {
  const rows = await openTasks(env, cols);
  if (!rows.length) return 'Открытых задач нет.';
  return rows.map((t) => `#${t.id} | ${t.title} | проект: ${t.project || '-'} | статус: ${(cols.find((c) => c.id === t.status) || {}).name || '-'} | дедлайн: ${(t.deadline || '-').replace('T', ' ')} | поставлена: ${t.created.replace('T', ' ')} | следующий шаг: ${t.next_step || '-'}`).join('\n');
}
const cleanProject = (p) => (PROJECTS.includes(p) ? p : PROJECTS.find((x) => x.toLowerCase() === String(p || '').toLowerCase().trim()) || '');
function colByName(cols, name) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  return cols.find((c) => c.id === name) || cols.find((c) => c.name.toLowerCase() === n) || null;
}

async function applyActions(env, actions, cols) {
  const out = [];
  const stamp = nowLocal();
  const firstOpen = (cols.find((c) => !c.done) || cols[0]).id;
  const firstDone = (cols.find((c) => c.done) || cols[cols.length - 1]).id;
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a !== 'object') continue;
    try {
      if (a.type === 'add' && a.title) {
        const status = (colByName(cols, a.status) || {}).id || firstOpen;
        const r = await env.DB.prepare('INSERT INTO tasks (title, project, next_step, deadline, created, status, pos) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(String(a.title).trim().slice(0, 500), cleanProject(a.project), a.next_step ? String(a.next_step).slice(0, 300) : '', parseDt(a.deadline), stamp, status, await nextPos(env)).run();
        out.push(taskCard(await getTask(env, r.meta.last_row_id), cols));
      } else if (a.type === 'done') {
        const t = await getTask(env, a.id);
        if (t && !doneIds(cols).includes(t.status)) {
          await env.DB.prepare('UPDATE tasks SET status=?, done_at=? WHERE id=?').bind(firstDone, stamp, t.id).run();
          out.push(`🏁 Закрыта #${t.id}: <b>${esc(t.title)}</b>`);
        }
      } else if (a.type === 'update') {
        const t = await getTask(env, a.id);
        if (t) {
          const f = {};
          if (a.title) f.title = String(a.title).trim().slice(0, 500);
          if (a.next_step) f.next_step = String(a.next_step).slice(0, 300);
          if (a.project) f.project = cleanProject(a.project);
          if ('deadline' in a) { f.deadline = parseDt(a.deadline); f.reminded = 0; }
          const c = colByName(cols, a.status);
          if (c) { f.status = c.id; f.done_at = c.done ? stamp : null; }
          const keys = Object.keys(f);
          if (keys.length) {
            await env.DB.prepare(`UPDATE tasks SET ${keys.map((k) => k + '=?').join(', ')} WHERE id=?`).bind(...keys.map((k) => f[k]), t.id).run();
            out.push(taskCard(await getTask(env, t.id), cols, '✏️ Обновлена'));
          }
        }
      } else if (a.type === 'delete') {
        const t = await getTask(env, a.id);
        if (t) { await env.DB.prepare('DELETE FROM tasks WHERE id=?').bind(t.id).run(); out.push(`🗑 Удалена #${t.id}: ${esc(t.title)}`); }
      } else if (a.type === 'list') {
        out.push(await listText(env, cols));
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
    } catch (e) { console.log('action failed', JSON.stringify(a), String(e)); }
  }
  return out;
}

// ---------- LLM ----------
const SYSTEM = `Ты — Джефф, личный ассистент и ментор предпринимателя. Он пишет тебе в Telegram как в обычный чат.
Твоя работа: превращать его сообщения в чёткие задачи, вести список и помогать его закрывать. Ты также ведёшь его намазы, истигфар и чтение суры Аль-Вакиа.

Отвечай ТОЛЬКО JSON-объектом:
{"reply": "текст ответа", "actions": [ ... ]}

Виды действий:
{"type": "add", "title": "...", "deadline": "YYYY-MM-DD HH:MM" или null, "project": "Newton" | "Be Soft" | null, "next_step": "..." или null}
{"type": "done", "id": 12}
{"type": "update", "id": 12, "title": "...", "deadline": "...", "project": "...", "next_step": "...", "status": "название колонки"}  (только изменяемые поля)
{"type": "delete", "id": 12}
{"type": "list"}
{"type": "prayer", "key": "bomdod" | "peshin" | "asr" | "shom" | "xufton" | "vitr", "done": true}
{"type": "istighfar", "value": 300, "mode": "set" | "add"}
{"type": "vakia", "done": true}
{"type": "prayers"}  (показать сводку молитв за сегодня)

Правила:
- Формулируй задачу грамотно: начинай с глагола, конкретный измеримый результат, без воды. Сохраняй имена, названия и цифры в точности как написал пользователь.
- В одном сообщении может быть несколько задач — создай каждую отдельно.
- Проект: только "Newton" или "Be Soft", если из сообщения это понятно; иначе null.
- Дедлайн: если пользователь назвал срок («завтра», «до пятницы», «через 2 часа») — переведи в точную дату и время от текущего момента. Если день есть, а времени нет — ставь 18:00. Если срока нет совсем — предложи реалистичный сам и скажи об этом в reply.
- Не ставь дедлайн в прошлое.
- next_step — первое конкретное действие на 5–15 минут, если оно очевидно.
- «сделал», «готово», «закрыл» → done по подходящей задаче из списка. «перенеси», «сдвинь» → update. Если непонятно, о какой задаче речь, — спроси, действий не делай.
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
async function contextHeader(env, cols) {
  const n = nowLocal();
  const d = new Date(n + ':00Z');
  return `Сейчас: ${n.replace('T', ' ')}, ${WEEKDAYS[d.getUTCDay()]} (Ташкент).\nКолонки канбана: ${cols.map((c) => c.name).join(', ')}.\nОткрытые задачи:\n${await tasksForPrompt(env, cols)}`;
}

// ---------- Обработка сообщений ----------
function welcome() {
  return 'Привет, я Джефф.\n\nПиши задачи как в обычный чат — я сформулирую, поставлю дедлайн и добавлю в трекер.\n' +
    'Например: «завтра до обеда отправить КП клиенту и созвониться с Азизом в четверг».\n\n' +
    '«Сделал КП» — закрою. «Перенеси созвон на пятницу» — перенесу.\n' +
    `Утром в ${MORNING} пришлю план, вечером в ${EVENING} — разбор дня.\n\n` +
    '🕌 В время намаза напомню и буду повторять каждые 10 минут, пока не отметишь.\n\n' +
    '/tasks — задачи, /namoz — молитвы, /istigfar 300 — истигфар за сегодня,\n/app — трекер, /site — ссылка для браузера.';
}
async function onMessage(env, msg) {
  if (!msg.from || msg.chat.type !== 'private') return;
  const cfg = await getMeta(env, 'cfg', {});
  const uid = String(msg.from.id);
  const text = (msg.text || '').trim();
  if (!cfg.owner) {
    if (!/^\/start/.test(text)) return;
    cfg.owner = uid; cfg.chat = msg.chat.id;
    cfg.webKey = (await sha256hex(crypto.randomUUID() + ':' + uid)).slice(0, 40);
    await setMeta(env, 'cfg', cfg);
  }
  if (uid !== cfg.owner) return;
  if (cfg.chat !== msg.chat.id) { cfg.chat = msg.chat.id; await setMeta(env, 'cfg', cfg); }
  if (!text) return;
  const chat = msg.chat.id;
  const cols = await getColumns(env);
  const appKb = { inline_keyboard: [[{ text: 'Открыть трекер', web_app: { url: APP_URL } }]] };

  if (/^\/start/.test(text)) return send(env, chat, welcome(), { reply_markup: appKb });
  if (/^\/tasks/.test(text)) return send(env, chat, await listText(env, cols), { reply_markup: appKb });
  if (/^\/app/.test(text)) return send(env, chat, 'Трекер задач и молитв:', { reply_markup: appKb });
  if (/^\/site/.test(text)) return send(env, chat, `Ссылка для обычного браузера (никому не пересылай — по ней открываются твои задачи):\n${APP_URL}#k=${cfg.webKey}`, { disable_web_page_preview: true });
  if (/^\/namoz/.test(text)) { const s = await prayerStatus(env, today()); return send(env, chat, s.text, { reply_markup: s.reply_markup }); }
  let m = text.match(/^\/istigfar(?:@\w+)?\s*(\+)?\s*(\d+)?/);
  if (m) {
    if (!m[2]) { const d = await getDay(env, today()); return send(env, chat, `📿 Истигфар сегодня: <b>${d.istighfar}</b>\nЗаписать: /istigfar 300, добавить: /istigfar +100`); }
    return send(env, chat, (await applyActions(env, [{ type: 'istighfar', value: Number(m[2]), mode: m[1] ? 'add' : 'set' }], cols)).join('\n'));
  }
  m = text.match(/^\/(done|del)(?:@\w+)?\s*#?(\d+)?/);
  if (m) {
    if (!m[2]) return send(env, chat, 'Укажи номер задачи, например: /done 3');
    const out = await applyActions(env, [{ type: m[1] === 'done' ? 'done' : 'delete', id: Number(m[2]) }], cols);
    return send(env, chat, out.join('\n') || 'Такой открытой задачи нет.');
  }
  if (text.startsWith('/')) return send(env, chat, 'Не знаю такой команды. Есть: /tasks, /namoz, /istigfar, /app, /site.');

  await tg(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
  const hist = await getMeta(env, 'hist', []);
  let data;
  try {
    data = extractJson(await llm(env, [{ role: 'system', content: SYSTEM + '\n\n' + (await contextHeader(env, cols)) }, ...hist, { role: 'user', content: text }]));
  } catch (e) {
    console.log('llm failed', String(e));
    return send(env, chat, 'Не смог обработать — модель не ответила. Попробуй ещё раз.');
  }
  const blocks = await applyActions(env, data.actions, cols);
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
async function cronDeadlines(env, chat, cols) {
  const now = nowLocal();
  const soon = nowLocal(Date.now() + REMIND_BEFORE_MIN * 60000);
  for (const t of await openTasks(env, cols)) {
    if (!t.deadline) continue;
    let text, stage;
    if (t.deadline <= now && t.reminded < 2) { text = `🔴 Дедлайн прошёл: #${t.id} <b>${esc(t.title)}</b>\nСделал или переносим?`; stage = 2; }
    else if (t.deadline > now && t.deadline <= soon && t.reminded < 1) { text = `⏰ Скоро дедлайн (${human(t.deadline)}): #${t.id} <b>${esc(t.title)}</b>`; stage = 1; }
    else continue;
    await send(env, chat, text);
    await env.DB.prepare('UPDATE tasks SET reminded=? WHERE id=?').bind(stage, t.id).run();
  }
}
async function cronDigest(env, chat, cols) {
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
    const done = (await allTasks(env)).filter((t) => (t.done_at || '').startsWith(date)).map((t) => t.title).join('; ') || 'ничего';
    const d = await getDay(env, date);
    const missed = PRAYERS.filter((p) => !d.prayers[p.key] && p.key !== 'xufton' && p.key !== 'vitr').map((p) => p.name).join(', ') || 'нет';
    ask = `Вечер. Закрыто сегодня: ${done}. Неотмеченные намазы за день: ${missed}. Истигфар: ${d.istighfar}. Аль-Вакиа: ${d.vakia ? 'прочитана' : 'не отмечена'}. ` +
      'Сделай короткий разбор дня: что закрыто, что зависло, что переносим. Спроси про одну самую важную незакрытую задачу — что мешает.';
  }
  let text;
  try {
    text = await llm(env, [
      { role: 'system', content: 'Ты — Джефф, ментор предпринимателя. Пиши коротко, прямо, на «ты», по-русски, обычным текстом без разметки. Ссылайся на задачи по номерам.\n\n' + (await contextHeader(env, cols)) },
      { role: 'user', content: ask }], false);
  } catch { text = null; }
  if (text) await tg(env, 'sendMessage', { chat_id: chat, text }); else await send(env, chat, await listText(env, cols));
}
async function runCron(env) {
  await ensureSchema(env);
  const cfg = await getMeta(env, 'cfg', {});
  if (!cfg.chat) return;
  const cols = await getColumns(env);
  for (const job of [() => cronPrayers(env, cfg.chat), () => cronDeadlines(env, cfg.chat, cols), () => cronDigest(env, cfg.chat, cols)]) {
    try { await job(); } catch (e) { console.log('cron job failed', String(e && e.stack || e)); }
  }
}

// ---------- API для трекера ----------
function cors(req) {
  const o = req.headers.get('Origin') || '';
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Jeff-Auth', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
  if (ORIGINS.some((re) => re.test(o))) h['Access-Control-Allow-Origin'] = o;
  return h;
}
const json = (req, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) } });
async function authorized(env, req) {
  const cfg = await getMeta(env, 'cfg', {});
  if (!cfg.owner) return false;
  const a = req.headers.get('X-Jeff-Auth') || '';
  if (a.startsWith('tma ')) return (await verifyInitData(env, a.slice(4))) === cfg.owner;
  if (a.startsWith('key ') && cfg.webKey) {
    const k = a.slice(4);
    if (k.length !== cfg.webKey.length) return false;
    let diff = 0;
    for (let i = 0; i < k.length; i++) diff |= k.charCodeAt(i) ^ cfg.webKey.charCodeAt(i);
    return diff === 0;
  }
  return false;
}
async function apiState(env, date) {
  const cols = await getColumns(env);
  const tasks = (await allTasks(env)).map((t) => ({ id: t.id, title: t.title, project: t.project || '', next_step: t.next_step || '', deadline: t.deadline || '', created: t.created, status: cols.some((c) => c.id === t.status) ? t.status : cols[0].id }));
  const sch = await daySchedule(env, date);
  const day = await getDay(env, date);
  const from = addDays(date, -6);
  const rows = (await env.DB.prepare('SELECT date, data FROM days WHERE date>=? AND date<=?').bind(from, date).all()).results || [];
  const byDate = {};
  for (const r of rows) { try { byDate[r.date] = JSON.parse(r.data); } catch {} }
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(date, -i), x = byDate[d] || {};
    week.push({ date: d, prayers: Object.keys(x.prayers || {}), istighfar: Number(x.istighfar) || 0, vakia: !!x.vakia });
  }
  return {
    now: nowLocal(), columns: cols, tasks, projects: PROJECTS,
    prayers: { date, source: sch ? sch.source : null, sunrise: sch ? sch.sunrise : null, list: PRAYERS.map((p) => { const s = sch && sch.list.find((x) => x.key === p.key); return { key: p.key, name: p.name, time: s ? s.time : null, end: s ? s.end : null, done: day.prayers[p.key] || false }; }), istighfar: day.istighfar, vakia: day.vakia, week },
  };
}
async function apiOp(env, op) {
  const cols = await getColumns(env);
  const stamp = nowLocal();
  const colId = (id) => (cols.some((c) => c.id === id) ? id : cols[0].id);
  switch (op.type) {
    case 'task.save': {
      const title = String(op.title || '').trim().slice(0, 500);
      if (!title) return { error: 'Пустая задача' };
      const status = colId(op.status);
      const doneAt = cols.find((c) => c.id === status).done ? stamp : null;
      if (op.id) {
        const t = await getTask(env, op.id);
        if (!t) return { error: 'Задача не найдена' };
        const deadline = parseDt(op.deadline);
        await env.DB.prepare('UPDATE tasks SET title=?, project=?, deadline=?, created=?, status=?, done_at=?, reminded=? WHERE id=?')
          .bind(title, cleanProject(op.project), deadline, parseDt(op.created) || t.created, status, doneAt, deadline === (t.deadline || '') ? t.reminded : 0, t.id).run();
      } else {
        await env.DB.prepare('INSERT INTO tasks (title, project, next_step, deadline, created, status, pos, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(title, cleanProject(op.project), '', parseDt(op.deadline), parseDt(op.created) || stamp, status, await nextPos(env), doneAt).run();
      }
      return {};
    }
    case 'task.delete': await env.DB.prepare('DELETE FROM tasks WHERE id=?').bind(Number(op.id)).run(); return {};
    case 'task.move': {
      const t = await getTask(env, op.id);
      if (!t) return { error: 'Задача не найдена' };
      const status = colId(op.status);
      let pos;
      const before = op.beforeId ? await getTask(env, op.beforeId) : null;
      if (before) {
        const prev = await env.DB.prepare('SELECT MAX(pos) AS m FROM tasks WHERE pos<? AND id!=?').bind(before.pos, t.id).first();
        pos = ((prev && prev.m != null ? prev.m : before.pos - 1) + before.pos) / 2;
      } else pos = await nextPos(env);
      const done = cols.find((c) => c.id === status).done;
      await env.DB.prepare('UPDATE tasks SET status=?, pos=?, done_at=? WHERE id=?').bind(status, pos, done ? (t.done_at || stamp) : null, t.id).run();
      return {};
    }
    case 'columns.set': {
      if (!Array.isArray(op.columns) || !op.columns.length || op.columns.length > 30) return { error: 'Нужна хотя бы одна колонка' };
      const next = [], seen = new Set();
      for (const c of op.columns) {
        const id = String(c.id || '').slice(0, 40), name = String(c.name || '').trim().slice(0, 60);
        if (!id || !name || seen.has(id)) continue;
        seen.add(id); next.push({ id, name, done: !!c.done });
      }
      if (!next.length) return { error: 'Нужна хотя бы одна колонка' };
      await setMeta(env, 'columns', next);
      // задачи из удалённых колонок переезжают в указанную или первую
      const fallback = seen.has(op.moveTo) ? op.moveTo : next[0].id;
      for (const c of cols) if (!seen.has(c.id)) await env.DB.prepare('UPDATE tasks SET status=? WHERE status=?').bind(fallback, c.id).run();
      return {};
    }
    case 'prayer.set': return (await markPrayer(env, op.date, op.key, !!op.done)) ? {} : { error: 'Неверные данные' };
    case 'istighfar.set': {
      if (!validDate(op.date) || !isFinite(Number(op.value))) return { error: 'Неверные данные' };
      const d = await getDay(env, op.date);
      d.istighfar = Math.max(0, Math.min(1000000, Math.round(Number(op.value))));
      await saveDay(env, op.date, d); return {};
    }
    case 'vakia.set': {
      if (!validDate(op.date)) return { error: 'Неверные данные' };
      const d = await getDay(env, op.date);
      d.vakia = !!op.done; await saveDay(env, op.date, d); return {};
    }
    default: return { error: 'Неизвестная операция' };
  }
}

async function setup(env, origin) {
  await ensureSchema(env);
  const out = {};
  out.webhook = (await tg(env, 'setWebhook', { url: origin + '/tg', secret_token: await webhookSecret(env), allowed_updates: ['message', 'callback_query'], drop_pending_updates: false })).ok;
  out.menu = (await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Трекер', web_app: { url: APP_URL } } })).ok;
  out.commands = (await tg(env, 'setMyCommands', { commands: [
    { command: 'tasks', description: 'Открытые задачи' }, { command: 'namoz', description: 'Молитвы на сегодня' },
    { command: 'istigfar', description: 'Истигфар за сегодня: /istigfar 300' }, { command: 'app', description: 'Открыть трекер' },
    { command: 'site', description: 'Ссылка на трекер для браузера' }] })).ok;
  return out;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
      if (url.pathname === '/tg' && req.method === 'POST') {
        if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (await webhookSecret(env))) return new Response('forbidden', { status: 403 });
        const update = await req.json();
        ctx.waitUntil((async () => {
          try {
            await ensureSchema(env);
            if (update.message) await onMessage(env, update.message);
            else if (update.callback_query) await onCallback(env, update.callback_query);
          } catch (e) { console.log('update failed', String(e && e.stack || e)); }
        })());
        return new Response('ok');
      }
      if (url.pathname === '/setup') return json(req, await setup(env, url.origin));
      if (url.pathname.startsWith('/api/')) {
        await ensureSchema(env);
        if (!(await authorized(env, req))) return json(req, { error: 'unauthorized' }, 401);
        const date = validDate(url.searchParams.get('day')) ? url.searchParams.get('day') : today();
        if (url.pathname === '/api/state' && req.method === 'GET') return json(req, await apiState(env, date));
        if (url.pathname === '/api/op' && req.method === 'POST') {
          const op = await req.json();
          const res = await apiOp(env, op || {});
          if (res.error) return json(req, res, 400);
          return json(req, await apiState(env, date));
        }
        return json(req, { error: 'not found' }, 404);
      }
      return new Response('Джефф на связи.', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } catch (e) {
      console.log('fetch failed', String(e && e.stack || e));
      return json(req, { error: 'server error' }, 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runCron(env)); },
};
