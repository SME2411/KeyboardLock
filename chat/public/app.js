const $ = (id) => document.getElementById(id);
let me, chats = [], current = null, ws, onlineIds = [], registering = false, retry = 0, actTimer = null, lastActSent = 0;

const api = async (path, body) => {
  const r = await fetch(path, body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Ошибка'), { status: r.status });
  return data;
};

// ---------- настройки (хранятся на устройстве) ----------
const DEFAULTS = { mode: 'system', style: 'graphite', anim: 'full', emojiAnim: true, bigEmoji: true, fontSize: 'm', enterSends: true, showTyping: true, compress: true };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('duoverse.settings') || '{}') }; } catch {}
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function applySettings() {
  const r = document.documentElement;
  const dark = settings.mode === 'dark' || (settings.mode === 'system' && darkMq.matches);
  r.dataset.mode = dark ? 'dark' : 'light'; r.dataset.style = settings.style; r.dataset.anim = settings.anim;
  r.dataset.emojiAnim = settings.emojiAnim ? 'on' : 'off'; r.dataset.fs = settings.fontSize;
  $('themeColor').content = getComputedStyle(r).getPropertyValue('--bg').trim() || '#ffffff';
}
function setSetting(k, v) { settings[k] = v; localStorage.setItem('duoverse.settings', JSON.stringify(settings)); applySettings(); }
darkMq.addEventListener('change', applySettings);

const SCHEMA = [
  { sec: 'Оформление' },
  { k: 'mode', t: 'seg', label: 'Тема', opts: [['system', 'Как в телефоне'], ['light', 'Светлая'], ['dark', 'Тёмная']] },
  { k: 'style', t: 'seg', label: 'Стиль', opts: [['graphite', 'Графит'], ['slate', 'Сланец'], ['amber', 'Янтарь']] },
  { k: 'fontSize', t: 'seg', label: 'Размер текста', opts: [['s', 'Мелкий'], ['m', 'Обычный'], ['l', 'Крупный']] },
  { sec: 'Анимации' },
  { k: 'anim', t: 'seg', label: 'Анимации', opts: [['full', 'Полные'], ['min', 'Минимум'], ['off', 'Выкл']] },
  { k: 'emojiAnim', t: 'sw', label: 'Анимация эмодзи', hint: 'Крупные эмодзи «подпрыгивают» при получении' },
  { k: 'bigEmoji', t: 'sw', label: 'Крупные эмодзи', hint: '1–3 эмодзи показываются без пузырька', reopen: true },
  { sec: 'Чат' },
  { k: 'enterSends', t: 'sw', label: 'Enter отправляет', hint: 'На компьютере; Shift+Enter — новая строка' },
  { k: 'showTyping', t: 'sw', label: 'Показывать, что я печатаю', hint: 'Если выключить, собеседник не увидит «печатает…»' },
  { k: 'compress', t: 'sw', label: 'Сжимать фото при отправке', hint: 'Меньше трафика, и пропадают метаданные (в т.ч. место съёмки)' },
];
function openSettings() {
  const sh = $('sheet'); sh.innerHTML = '';
  const head = document.createElement('div'); head.className = 'sheet-head';
  head.innerHTML = '<h2>Настройки</h2>'; const x = document.createElement('button'); x.className = 'icon-btn'; x.textContent = '✕'; x.setAttribute('aria-label', 'Закрыть');
  x.onclick = closeSettings; head.append(x); sh.append(head);
  for (const it of SCHEMA) {
    if (it.sec) { const s = document.createElement('div'); s.className = 'sec'; s.textContent = it.sec; sh.append(s); continue; }
    const row = document.createElement('div'); row.className = 'row' + (it.t === 'sw' ? ' inline' : '');
    const lab = document.createElement('div'); lab.textContent = it.label;
    if (it.hint) { const h = document.createElement('small'); h.textContent = it.hint; lab.append(h); }
    if (it.t === 'seg') {
      const seg = document.createElement('div'); seg.className = 'seg';
      for (const [val, text] of it.opts) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.classList.toggle('active', settings[it.k] === val);
        b.onclick = () => { setSetting(it.k, val); [...seg.children].forEach((c) => c.classList.toggle('active', c === b)); };
        seg.append(b);
      }
      row.append(lab, seg);
    } else {
      const sw = document.createElement('button'); sw.type = 'button'; sw.className = 'sw'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!settings[it.k]));
      sw.onclick = () => { setSetting(it.k, !settings[it.k]); sw.setAttribute('aria-checked', String(!!settings[it.k])); if (it.reopen && current) openChat(current); };
      row.append(lab, sw);
    }
    sh.append(row);
  }
  // уведомления и аккаунт
  const s = document.createElement('div'); s.className = 'sec'; s.textContent = 'Уведомления и аккаунт'; sh.append(s);
  const nrow = document.createElement('div'); nrow.className = 'row inline';
  const nl = document.createElement('div'); nl.textContent = 'Push-уведомления'; const nh = document.createElement('small'); nl.append(nh);
  const nb = document.createElement('button'); nb.className = 'btn'; nrow.append(nl, nb); sh.append(nrow);
  refreshPushRow(nh, nb);
  const arow = document.createElement('div'); arow.className = 'row inline';
  const al = document.createElement('div'); al.textContent = 'Вы вошли как ' + me.username;
  const lo = document.createElement('button'); lo.className = 'btn danger'; lo.textContent = 'Выйти'; lo.onclick = logout;
  arow.append(al, lo); sh.append(arow);
  const pad = document.createElement('div'); pad.className = 'pad'; sh.append(pad);
  $('settings').hidden = false;
}
const closeSettings = () => { $('settings').hidden = true; };
$('sheetBg').onclick = closeSettings;
$('settingsBtn').onclick = openSettings;
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

async function refreshPushRow(hint, btn) {
  if (!pushSupported()) {
    hint.textContent = isIOS() && !isStandalone() ? 'На iPhone: «Поделиться» → «На экран «Домой»», затем откройте приложение оттуда' : 'Этот браузер не поддерживает уведомления';
    btn.hidden = true; return;
  }
  const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
  const on = Notification.permission === 'granted' && !!sub;
  hint.textContent = Notification.permission === 'denied' ? 'Запрещены в настройках телефона или браузера' : on ? 'Включены на этом устройстве' : 'Выключены';
  btn.hidden = Notification.permission === 'denied'; btn.textContent = on ? 'Выключить' : 'Включить';
  btn.onclick = async () => {
    try {
      if (on) { await api('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      else if ((await Notification.requestPermission()) === 'granted') await subscribePush();
    } catch (e) { alert('Не получилось: ' + e.message); }
    refreshPushRow(hint, btn); updateBanner();
  };
}

// ---------- вход ----------
$('toggle').onclick = (e) => {
  e.preventDefault(); registering = !registering;
  $('invite').hidden = !registering;
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('authBtn').textContent = registering ? 'Зарегистрироваться' : 'Войти';
  $('toggle').textContent = registering ? 'Уже есть аккаунт? Войти' : 'Первый раз? Зарегистрироваться';
};
$('authForm').onsubmit = async (e) => {
  e.preventDefault(); $('authErr').textContent = '';
  try {
    await api(registering ? '/api/register' : '/api/login',
      { username: $('username').value, password: $('password').value, invite: $('invite').value });
    start();
  } catch (err) { $('authErr').textContent = err.message; }
};
async function logout() {
  try { const reg = await navigator.serviceWorker?.ready; const s = await reg?.pushManager.getSubscription();
    if (s) { await api('/api/push/unsubscribe', { endpoint: s.endpoint }); await s.unsubscribe(); } } catch {}
  await api('/api/logout', {}); ws?.close(); location.reload();
}

async function start() {
  applySettings();
  try { me = await api('/api/me'); } catch { $('auth').hidden = false; $('app').hidden = true; return; }
  $('auth').hidden = true; $('app').hidden = false;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  await loadChats();
  connect();
  updateBanner();
  buildEmoji();
}

// ---------- чаты: собеседники, «Избранное» (чат с собой), служебный «DuoVerse» ----------
const BOT_WELCOME = [
  'Добро пожаловать в DuoVerse 👋\nЭто ваш личный мессенджер на двоих: без посторонних и без рекламы.',
  'Что здесь умеет:\n• сообщения в реальном времени\n• фото, видео, аудио и файлы до 100 МБ\n• эмодзи и статусы «в сети», «печатает…»\n• уведомления, даже когда приложение закрыто',
  '«Избранное» — чат с самим собой для заметок, ссылок и файлов. Там удобно пробовать любые функции.',
  'Уведомления на iPhone: в Safari нажмите «Поделиться» → «На экран «Домой»», затем открывайте DuoVerse с экрана.',
  'Внешний вид, тема и анимации настраиваются кнопкой ⚙ в списке чатов.',
];
const botChat = () => ({ id: -1, username: 'DuoVerse', name: 'DuoVerse', kind: 'bot', unread: localStorage.getItem('welcomeSeen') ? 0 : 1, last: null });
const toChat = (u) => ({ ...u, kind: u.self ? 'self' : 'user', name: u.self ? 'Избранное' : u.username });
async function loadChats() {
  const list = await api('/api/chats');
  chats = [...list.map(toChat), botChat()];
  if (current) current = chats.find((c) => c.id === current.id) || current;
  renderChats(); updateStatus();
}
const refreshChats = loadChats;

// ---------- аватарки ----------
const BOOKMARK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/></svg>';
function setAvatar(el, c) {
  el.className = 'avatar'; el.textContent = '';
  if (c.kind === 'self') { el.classList.add('ic'); el.innerHTML = BOOKMARK; }
  else if (c.kind === 'bot') { el.classList.add('mono-av'); el.textContent = 'D'; }
  else { el.textContent = c.username[0].toUpperCase(); el.classList.toggle('on', onlineIds.includes(c.id)); }
}

// ---------- статус: в сети / был(а) / действие ----------
const ACTION_TEXT = { typing: 'печатает', voice: 'записывает голосовое', video: 'записывает видео', photo: 'отправляет фото', file: 'отправляет файл' };
function seenText(u) {
  if (onlineIds.includes(u.id)) return 'в сети';
  if (!u.last_seen) return 'не в сети';
  const d = new Date(u.last_seen), now = new Date();
  const t = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `был(а) в ${t}`;
  if (new Date(now - 864e5).toDateString() === d.toDateString()) return `был(а) вчера в ${t}`;
  return `был(а) ${d.toLocaleDateString('ru', { day: 'numeric', month: 'short' })}`;
}
let activity = null;   // { from, kind, until }
const activeAction = (uid) => (activity && activity.from === uid && Date.now() < activity.until) ? activity.kind : null;
function updateStatus() {
  if (!current) return;
  const st = $('status'), act = current.kind === 'user' ? activeAction(current.id) : null;
  if (current.kind === 'self') { st.textContent = 'заметки и файлы для себя'; st.className = ''; return; }
  if (current.kind === 'bot') { st.textContent = 'служебный чат'; st.className = ''; return; }
  $('avatar').classList.toggle('on', onlineIds.includes(current.id));
  if (act) { st.textContent = ACTION_TEXT[act]; st.className = 'live dots'; }
  else { st.textContent = seenText(current); st.className = onlineIds.includes(current.id) ? 'live' : ''; }
}
function sendAction(kind) {   // не чаще раза в 2.5 секунды; себе и боту не шлём
  if (!current || current.kind !== 'user' || ws?.readyState !== 1 || Date.now() - lastActSent < 2500) return;
  if (kind === 'typing' && !settings.showTyping) return;
  lastActSent = Date.now(); ws.send(JSON.stringify({ type: 'act', to: current.id, kind }));
}

// ---------- push-уведомления ----------
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function showBanner(text, withBtn) { $('banner').hidden = !text; $('bannerText').textContent = text || ''; $('bannerBtn').hidden = !withBtn; }
function updateBanner() {
  if (!pushSupported()) {
    if (isIOS() && !isStandalone()) showBanner('Чтобы получать уведомления на iPhone: «Поделиться» в Safari → «На экран «Домой»», затем откройте DuoVerse с экрана.', false);
    else showBanner('', false);
  } else if (Notification.permission === 'granted') { showBanner('', false); subscribePush().catch(console.error); }
  else if (Notification.permission === 'denied') showBanner('Уведомления запрещены. Разрешите их в настройках телефона или браузера.', false);
  else showBanner('Включите уведомления, чтобы не пропускать сообщения.', true);
}
$('bannerBtn').onclick = async () => {   // запрос разрешения обязан идти из нажатия (требование iOS)
  const perm = await Notification.requestPermission();
  if (perm === 'granted') { try { await subscribePush(); } catch (e) { alert('Не удалось подписаться: ' + e.message); } }
  updateBanner();
};
const b64ToBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await api('/api/push/key');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  }
  await api('/api/push/subscribe', sub.toJSON());
}

// ---------- список чатов ----------
const fileLabel = (mime, name) => mime.startsWith('image/') ? '📷 Фото' : mime.startsWith('video/') ? '🎬 Видео' : mime.startsWith('audio/') ? '🎵 Аудио' : '📎 ' + name;
function previewOf(c) {
  if (c.kind === 'bot') return 'Как пользоваться DuoVerse';
  if (c.kind === 'user' && activeAction(c.id)) return ACTION_TEXT[activeAction(c.id)] + '…';
  if (!c.last) return c.kind === 'self' ? 'Заметки, ссылки и файлы для себя' : 'Сообщений пока нет';
  const l = c.last, body = l.file ? fileLabel(l.file.mime, l.file.name) + (l.text ? ' ' + l.text : '') : l.text;
  return (l.from_id === me.id && c.kind === 'user' ? 'Вы: ' : '') + body;
}
function listTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (now - d < 6 * 864e5) return d.toLocaleDateString('ru', { weekday: 'short' });
  return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit' });
}
function renderChats() {
  const box = $('contacts'); box.innerHTML = '';
  const order = { user: 0, self: 1, bot: 2 };
  const list = [...chats].sort((a, b) => order[a.kind] - order[b.kind] || (b.last?.created_at || 0) - (a.last?.created_at || 0));
  list.forEach((c, i) => {
    const d = document.createElement('div'); d.className = 'contact' + (current?.id === c.id ? ' active' : ''); d.style.animationDelay = i * 40 + 'ms';
    const av = document.createElement('div'); setAvatar(av, c);
    const meta = document.createElement('div'); meta.className = 'meta';
    const l1 = document.createElement('div'); l1.className = 'l1';
    const b = document.createElement('b'); b.textContent = c.name; const tm = document.createElement('time'); tm.textContent = listTime(c.last?.created_at);
    l1.append(b, tm);
    const l2 = document.createElement('div'); l2.className = 'l2';
    const pv = document.createElement('span'); pv.className = 'pv' + (c.kind === 'user' && activeAction(c.id) ? ' live' : ''); pv.textContent = previewOf(c); l2.append(pv);
    if (c.unread) { const u = document.createElement('span'); u.className = 'unread'; u.textContent = c.unread; l2.append(u); }
    meta.append(l1, l2); d.append(av, meta);
    d.onclick = () => openChat(c);
    box.append(d);
  });
  if (!chats.some((c) => c.kind === 'user')) {
    const h = document.createElement('div'); h.className = 'hint';
    h.textContent = 'Второй участник ещё не зарегистрировался. Как только он войдёт по коду приглашения, чат появится здесь.'; box.append(h);
  }
}
$('back').onclick = () => {
  current = null; $('app').dataset.view = 'list'; $('chat').hidden = true; $('empty').hidden = false;
  $('emoji').hidden = true; $('emojiBtn').textContent = '😊'; renderChats();
};

// ---------- чат ----------
let lastDay = '', lastFrom = null, lastTime = 0, openSeq = 0, lastRendered = 0;
const seen = new Set();   // id уже показанных сообщений: защита от дублей
async function openChat(c) {
  const my = ++openSeq;
  current = c; $('app').dataset.view = 'chat'; $('empty').hidden = true; $('chat').hidden = false;
  setAvatar($('avatar'), c); $('title').textContent = c.name; updateStatus();
  const bot = c.kind === 'bot';
  $('composer').hidden = bot; $('readonly').hidden = !bot; if (bot) $('emoji').hidden = true;
  $('messages').innerHTML = ''; lastDay = ''; lastFrom = null; lastTime = 0; seen.clear(); lastRendered = 0;
  if (bot) {
    if (!localStorage.getItem('welcomeTime')) localStorage.setItem('welcomeTime', Date.now());
    const t0 = Number(localStorage.getItem('welcomeTime'));
    BOT_WELCOME.forEach((text, i) => addMsg({ id: -(i + 1), from_id: -1, to_id: me.id, text, created_at: t0 + i * 1000 }, false));
    localStorage.setItem('welcomeSeen', '1'); c.unread = 0; renderChats(); scrollDown(false); return;
  }
  renderChats();
  const list = await api('/api/messages?with=' + c.id);
  if (my !== openSeq) return;   // за время загрузки чат открыли заново: этот ответ устарел
  list.forEach((m) => addMsg(m, false)); scrollDown(false);
  markRead(c);
}
function markRead(c) {
  if (c.kind !== 'user' || !isVisible()) return;
  const mine = lastRendered; if (!mine) return;
  if (c.unread || c.readUpto !== mine) { c.readUpto = mine; c.unread = 0; api('/api/read', { with: c.id, upto: mine }).catch(() => {}); renderChats(); }
}
const segmenter = 'Segmenter' in Intl ? new Intl.Segmenter() : null;
function isBigEmoji(text) {
  if (!settings.bigEmoji) return false;
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|⃣|\s)+$/u.test(text)) return false;
  const n = segmenter ? [...segmenter.segment(text.replace(/\s/g, ''))].length : [...text].length;
  return n >= 1 && n <= 3;
}
function addMsg(m, animate = true) {
  if (seen.has(m.id)) return;
  seen.add(m.id); if (m.id > lastRendered) lastRendered = m.id;
  const box = $('messages'), d = new Date(m.created_at), day = d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
  if (day !== lastDay) { const s = document.createElement('div'); s.className = 'day'; s.textContent = day; box.append(s); lastDay = day; lastFrom = null; }
  const cont = lastFrom === m.from_id && m.created_at - lastTime < 2 * 60 * 1000;
  lastFrom = m.from_id; lastTime = m.created_at;
  const el = document.createElement('div');
  const media = !!m.file;
  el.className = 'msg' + (m.from_id === me.id ? ' me' : '') + (cont ? ' cont' : '') + (animate ? ' pop' : '') + (media ? ' media' : (isBigEmoji(m.text) ? ' big' : ''));
  if (media) {
    el.append(fileNode(m.file));
    if (m.text) { const c = document.createElement('div'); c.className = 'cap'; c.textContent = m.text; el.append(c); }
  } else el.textContent = m.text;
  const t = document.createElement('time'); t.textContent = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  el.append(t); box.append(el);
}
const scrollDown = (smooth = true) => { const b = $('messages'); b.style.scrollBehavior = smooth ? 'smooth' : 'auto'; b.scrollTop = b.scrollHeight; };

// ---------- ввод ----------
const ta = $('text');
function syncSend() { $('sendBtn').classList.toggle('idle', !ta.value.trim()); }
function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 130) + 'px'; syncSend(); }
ta.addEventListener('input', () => { autosize(); sendAction('typing'); });
$('composer').onsubmit = (e) => { e.preventDefault(); sendText(); };
ta.onkeydown = (e) => {
  const mobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
  if (e.key === 'Enter' && !e.shiftKey && !mobile && settings.enterSends) { e.preventDefault(); sendText(); }
};
function sendText() {
  const text = ta.value.trim();
  if (!text || !current || current.kind === 'bot' || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'msg', to: current.id, text }));
  ta.value = ''; autosize(); ta.focus();
}

// ---------- файлы ----------
const MAX_MB = 100;
const fileUrl = (f, dl) => `/api/file/${f.id}${dl ? '?dl=1' : ''}`;
const fmtSize = (n) => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ';
function fit(f, maxW = 320, maxH = 380) {
  if (!f.w || !f.h) return null;
  const k = Math.min(maxW / f.w, maxH / f.h, 1); return { w: Math.round(f.w * k), h: Math.round(f.h * k) };
}
function docNode(f) {
  const a = document.createElement('a'); a.className = 'doc'; a.href = fileUrl(f, true); a.download = f.name;
  const ic = document.createElement('div'); ic.className = 'ic'; ic.textContent = (f.name.includes('.') ? f.name.split('.').pop() : 'FILE').slice(0, 4).toUpperCase();
  const tx = document.createElement('div'); const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = f.name;
  const sm = document.createElement('small'); sm.textContent = fmtSize(f.size); tx.append(nm, sm); a.append(ic, tx); return a;
}
function fileNode(f) {
  const size = fit(f), setSize = (el) => { if (size) { el.style.width = size.w + 'px'; el.style.height = size.h + 'px'; } };
  if (/^image\/(jpeg|png|gif|webp|avif|heic|heif)$/.test(f.mime)) {
    const img = document.createElement('img'); img.className = 'pic'; img.loading = 'lazy'; img.alt = f.name; img.src = fileUrl(f); setSize(img);
    img.onclick = () => openLightbox(f);
    img.onerror = () => img.replaceWith(docNode(f));   // формат не поддерживается браузером: покажем как файл
    return img;
  }
  if (/^video\/(mp4|quicktime|webm|x-m4v)$/.test(f.mime)) {
    const v = document.createElement('video'); v.className = 'vid'; v.controls = true; v.playsInline = true; v.preload = 'metadata'; v.src = fileUrl(f) + (f.id ? '#t=0.001' : ''); setSize(v);
    v.onerror = () => v.replaceWith(docNode(f)); return v;
  }
  if (/^audio\//.test(f.mime) && /^audio\/(mpeg|mp4|x-m4a|aac|webm|ogg|wav|x-wav)$/.test(f.mime)) {
    const au = document.createElement('audio'); au.className = 'audio'; au.controls = true; au.preload = 'metadata'; au.src = fileUrl(f); return au;
  }
  return docNode(f);
}
function openLightbox(f) {
  const lb = $('lightbox'); lb.querySelector('img').src = fileUrl(f); $('lbDl').href = fileUrl(f, true); $('lbDl').download = f.name; lb.hidden = false;
}
$('lightbox').onclick = (e) => { if (e.target.id !== 'lbDl') $('lightbox').hidden = true; };
addEventListener('keydown', (e) => { if (e.key === 'Escape') $('lightbox').hidden = true; });

// сжатие JPEG: уменьшаем до 2560 px и перекодируем (заодно пропадает EXIF с геопозицией)
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  let { width: w, height: h } = bmp, blob = file;
  if (settings.compress && file.type === 'image/jpeg') {
    const k = Math.min(1, 2560 / Math.max(w, h)); const cw = Math.round(w * k), ch = Math.round(h * k);
    const c = document.createElement('canvas'); c.width = cw; c.height = ch; c.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    if (out) { blob = out; w = cw; h = ch; }
  }
  bmp.close?.(); return { blob, w, h };
}
const videoDims = (file) => new Promise((res, rej) => {
  const v = document.createElement('video'), u = URL.createObjectURL(file); v.preload = 'metadata';
  v.onloadedmetadata = () => { res({ w: v.videoWidth, h: v.videoHeight }); URL.revokeObjectURL(u); };
  v.onerror = () => { rej(); URL.revokeObjectURL(u); }; v.src = u;
});

async function uploadOne(file) {
  const to = current.id, box = $('messages');
  const ph = document.createElement('div'); ph.className = 'msg me upl' + (box.lastElementChild ? '' : '');
  const label = document.createElement('div'); label.textContent = file.name || 'файл';
  const bar = document.createElement('div'); bar.className = 'bar'; const fill = document.createElement('i'); bar.append(fill);
  const st = document.createElement('small'); st.textContent = 'Подготовка…'; ph.append(label, bar, st); box.append(ph); scrollDown();
  const fail = (msg) => { st.textContent = msg; bar.remove(); setTimeout(() => ph.remove(), 6000); };
  if (file.size > MAX_MB * 1048576) return fail(`Файл больше ${MAX_MB} МБ`);

  let blob = file, name = file.name || 'file', mime = file.type || 'application/octet-stream', w, h;
  try {
    if (/^image\/(jpeg|png|webp|avif|heic|heif)$/.test(mime)) {
      const r = await prepareImage(file); blob = r.blob; w = r.w; h = r.h;
      if (blob !== file) name = name.replace(/\.[^.]+$/, '') + '.jpg';
    } else if (mime.startsWith('video/')) ({ w, h } = await videoDims(file));
  } catch { /* размеры необязательны: отправим как есть */ }

  const kind = mime.startsWith('image/') ? 'photo' : 'file';
  const ticker = setInterval(() => sendAction(kind), 1000); sendAction(kind);
  await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?to=${to}${w ? `&w=${w}&h=${h}` : ''}`);
    xhr.setRequestHeader('Content-Type', mime); xhr.setRequestHeader('X-Filename', encodeURIComponent(name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { fill.style.width = (e.loaded / e.total * 100) + '%'; st.textContent = `${fmtSize(e.loaded)} из ${fmtSize(e.total)}`; } };
    xhr.onload = () => {
      if (xhr.status === 200) ph.remove();
      else { let m = 'Не удалось отправить'; try { m = JSON.parse(xhr.responseText).error || m; } catch {} fail(m); }
      resolve();
    };
    xhr.onerror = () => { fail('Нет связи. Файл не отправлен'); resolve(); };
    xhr.send(blob);
  });
  clearInterval(ticker);
}
let uploading = Promise.resolve();
function sendFiles(files) {
  if (!current || current.kind === 'bot') return;
  for (const f of files) uploading = uploading.then(() => uploadOne(f)).catch(console.error);   // по очереди
}
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { sendFiles([...e.target.files]); e.target.value = ''; };
ta.addEventListener('paste', (e) => { const fs = e.clipboardData?.files; if (fs?.length) { e.preventDefault(); sendFiles([...fs]); } });
const chatEl = $('chat'); let dragDepth = 0;
chatEl.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; chatEl.classList.add('drag'); } });
chatEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; chatEl.classList.remove('drag'); } });
chatEl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
chatEl.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; chatEl.classList.remove('drag'); if (e.dataTransfer?.files.length) sendFiles([...e.dataTransfer.files]); });

// ---------- эмодзи ----------
const EMOJI = {
  '😊': '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 ☺️ 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🫢 🤫 🫠 😶 😐 😑 😬 🙄 😯 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 😈 💀 🤡 👻 👽 🤖',
  '❤️': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 😻 😽 💋 🫶 👍 👎 👌 🤌 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👏 🙌 👐 🤲 🤝 🙏 💪 🫂 👀 🧠 🫦',
  '🐱': '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦆 🦉 🦄 🐝 🦋 🐢 🐙 🐬 🐳 🌸 🌹 🌺 🌻 🌷 🌲 🌴 🍀 🌈 ☀️ 🌙 ⭐ ✨ ⚡ 🔥 ❄️ 🌊 ☁️ 🌧️',
  '🍕': '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍑 🍒 🥑 🍕 🍔 🍟 🌭 🌮 🍣 🍜 🍰 🎂 🍩 🍪 🍫 🍿 ☕ 🍵 🍺 🍷 🥂 🍾 🧁 🍦',
  '🎉': '⚽ 🏀 🎮 🎧 🎤 🎬 🎁 🎉 🎊 🏆 📷 💻 📱 💡 📚 ✈️ 🚗 🏠 🌍 💎 🔑 🎵 🎶 🕯️ 🧸 🛌 🚀 ⏰ 💌 📌 ✅ ❌ ❓ ❗ 💯',
};
function buildEmoji() {
  const tabs = $('emojiTabs'); if (tabs.childElementCount) return;
  const recent = () => JSON.parse(localStorage.getItem('recentEmoji') || '[]');
  const cats = { '🕘': () => recent(), ...Object.fromEntries(Object.entries(EMOJI).map(([k, v]) => [k, () => v.split(' ')])) };
  const show = (key) => {
    [...tabs.children].forEach((b) => b.classList.toggle('active', b.dataset.k === key));
    const grid = $('emojiGrid'); grid.innerHTML = ''; grid.scrollTop = 0;
    const list = cats[key]();
    if (!list.length) { const d = document.createElement('div'); d.className = 'empty'; d.style.gridColumn = '1/-1'; d.textContent = 'Здесь появятся недавние'; grid.append(d); }
    for (const e of list) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = e;
      b.onclick = () => {
        const s = ta.selectionStart ?? ta.value.length, en = ta.selectionEnd ?? s;
        ta.value = ta.value.slice(0, s) + e + ta.value.slice(en); ta.selectionStart = ta.selectionEnd = s + e.length; autosize();
        localStorage.setItem('recentEmoji', JSON.stringify([e, ...recent().filter((x) => x !== e)].slice(0, 24)));
      };
      grid.append(b);
    }
  };
  for (const k of Object.keys(cats)) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = k; b.dataset.k = k; b.onclick = () => show(k); tabs.append(b);
  }
  $('emojiBtn').onclick = () => {
    const open = $('emoji').hidden; $('emoji').hidden = !open;
    $('emojiBtn').textContent = open ? '⌨️' : '😊';
    if (open) show(recent().length ? '🕘' : '😊'); else ta.focus();
    setTimeout(() => scrollDown(false), 30);
  };
}

// ---------- websocket с автопереподключением ----------
const isVisible = () => !document.hidden && document.hasFocus();
const sendVis = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'vis', visible: isVisible() })); };
['visibilitychange', 'focus', 'blur'].forEach((ev) => addEventListener(ev, sendVis));

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { retry = 0; sendVis(); if (current) openChat(current); };
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'presence') {
      onlineIds = d.online;
      if (activity && !onlineIds.includes(activity.from)) activity = null;   // человек вышел: «печатает» гасим сразу
      if (d.left) { const u = chats.find((x) => x.id === d.left.id); if (u) u.last_seen = d.left.at; }
      if (d.online.some((id) => !chats.some((c) => c.id === id))) refreshChats();   // зарегистрировался новый участник
      else { renderChats(); updateStatus(); }
    }
    if (d.type === 'act') {
      activity = { from: d.from, kind: d.kind, until: Date.now() + 3500 }; updateStatus(); renderChats();
      clearTimeout(actTimer); actTimer = setTimeout(() => { updateStatus(); renderChats(); }, 3600);
    }
    if (d.type === 'msg') {
      const m = d.msg, other = m.from_id === me.id ? m.to_id : m.from_id, c = chats.find((x) => x.id === other && x.kind !== 'bot');
      if (!c) { refreshChats(); return; }
      c.last = { id: m.id, from_id: m.from_id, text: m.text, created_at: m.created_at, file: m.file ? { mime: m.file.mime, name: m.file.name } : null };
      const incoming = m.from_id !== me.id;
      if (incoming && activity?.from === other) activity = null;   // сообщение пришло: «печатает…» больше не нужно
      if (current?.id === other) {
        if (incoming) updateStatus();
        const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 160;
        addMsg(m); if (nearBottom || !incoming) scrollDown();
        if (incoming) { if (isVisible()) markRead(c); else c.unread = (c.unread || 0) + 1; }
      } else if (incoming) c.unread = (c.unread || 0) + 1;
      renderChats();
    }
  };
  ws.onclose = () => { setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000)); };
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && ws?.readyState !== 1) { ws?.close(); connect(); } });
addEventListener('focus', () => { if (current) markRead(current); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && current) markRead(current); });

syncSend();
start();
