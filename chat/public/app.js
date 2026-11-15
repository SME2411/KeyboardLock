const $ = (id) => document.getElementById(id);
let me, users = [], current = null, ws, onlineIds = [], registering = false, retry = 0, actTimer = null, lastActSent = 0;
const unread = {};
let activity = null;   // { from, kind, until }

const api = async (path, body) => {
  const r = await fetch(path, body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Ошибка'), { status: r.status });
  return data;
};

// ---------- настройки (хранятся на устройстве) ----------
const DEFAULTS = { mode: 'system', style: 'graphite', anim: 'full', emojiAnim: true, bigEmoji: true, fontSize: 'm', enterSends: true, showTyping: true };
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
  users = await api('/api/users');
  renderContacts();
  connect();
  updateBanner();
  buildEmoji();
  if (users.length === 1) openChat(users[0]);
}

// ---------- аватарки ----------
function setAvatar(el, name, on) { el.textContent = name[0].toUpperCase(); el.classList.toggle('on', !!on); }

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
const activeAction = (uid) => (activity && activity.from === uid && Date.now() < activity.until) ? activity.kind : null;
function updateStatus() {
  if (!current) return;
  const st = $('status'), act = activeAction(current.id);
  $('avatar').classList.toggle('on', onlineIds.includes(current.id));
  if (act) { st.textContent = ACTION_TEXT[act]; st.className = 'live dots'; }
  else { st.textContent = seenText(current); st.className = onlineIds.includes(current.id) ? 'live' : ''; }
}
function sendAction(kind) {   // не чаще раза в 2.5 секунды
  if (!current || ws?.readyState !== 1 || Date.now() - lastActSent < 2500) return;
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

// ---------- контакты ----------
async function refreshUsers() {
  users = await api('/api/users');
  if (!current && users.length === 1) openChat(users[0]);
  else { if (!current) renderContacts(); updateStatus(); }
}
function renderContacts() {
  const box = $('contacts'); box.innerHTML = '';
  if (!users.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'Пока никого нет. Пусть второй человек зарегистрируется.'; box.append(d); }
  users.forEach((u, i) => {
    const d = document.createElement('div'); d.className = 'contact'; d.style.animationDelay = i * 50 + 'ms';
    const av = document.createElement('div'); av.className = 'avatar'; setAvatar(av, u.username, onlineIds.includes(u.id));
    const meta = document.createElement('div'); meta.className = 'meta';
    const b = document.createElement('b'); b.textContent = u.username; const sm = document.createElement('small'); sm.textContent = seenText(u);
    meta.append(b, sm); d.append(av, meta);
    if (unread[u.id]) { const c = document.createElement('span'); c.className = 'unread'; c.textContent = unread[u.id]; d.append(c); }
    d.onclick = () => openChat(u);
    box.append(d);
  });
}
$('back').onclick = () => {
  current = null; $('chat').hidden = true; $('contacts').hidden = false; $('back').hidden = true; $('avatar').hidden = true;
  $('title').textContent = 'DuoVerse'; $('status').textContent = ''; $('emoji').hidden = true; $('emojiBtn').textContent = '😊'; renderContacts();
};

// ---------- чат ----------
let lastDay = '', lastFrom = null, lastTime = 0, openSeq = 0;
const seen = new Set();   // id уже показанных сообщений: защита от дублей
async function openChat(u) {
  const my = ++openSeq;
  current = u; unread[u.id] = 0;
  $('contacts').hidden = true; $('chat').hidden = false; $('back').hidden = users.length === 1;
  $('avatar').hidden = false; setAvatar($('avatar'), u.username, onlineIds.includes(u.id));
  $('title').textContent = u.username; updateStatus();
  $('messages').innerHTML = ''; lastDay = ''; lastFrom = null; lastTime = 0; seen.clear();
  const list = await api('/api/messages?with=' + u.id);
  if (my !== openSeq) return;   // за время загрузки чат открыли заново: этот ответ устарел
  list.forEach((m) => addMsg(m, false)); scrollDown(false);
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
  seen.add(m.id);
  const box = $('messages'), d = new Date(m.created_at), day = d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
  if (day !== lastDay) { const s = document.createElement('div'); s.className = 'day'; s.textContent = day; box.append(s); lastDay = day; lastFrom = null; }
  const cont = lastFrom === m.from_id && m.created_at - lastTime < 2 * 60 * 1000;
  lastFrom = m.from_id; lastTime = m.created_at;
  const el = document.createElement('div');
  el.className = 'msg' + (m.from_id === me.id ? ' me' : '') + (cont ? ' cont' : '') + (animate ? ' pop' : '') + (isBigEmoji(m.text) ? ' big' : '');
  el.textContent = m.text;
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
  if (!text || !current || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'msg', to: current.id, text }));
  ta.value = ''; autosize(); ta.focus();
}

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
      if (d.left) { const u = users.find((x) => x.id === d.left.id); if (u) u.last_seen = d.left.at; }
      if (d.online.some((id) => id !== me.id && !users.some((u) => u.id === id))) refreshUsers();
      else { if (!current) renderContacts(); updateStatus(); }
    }
    if (d.type === 'act') {
      activity = { from: d.from, kind: d.kind, until: Date.now() + 3500 }; updateStatus();
      clearTimeout(actTimer); actTimer = setTimeout(updateStatus, 3600);
    }
    if (d.type === 'msg') {
      const other = d.msg.from_id === me.id ? d.msg.to_id : d.msg.from_id;
      if (current?.id === other) {
        activity = null; updateStatus();
        const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 160;
        addMsg(d.msg); if (nearBottom || d.msg.from_id === me.id) scrollDown();
      } else if (d.msg.from_id !== me.id) { unread[other] = (unread[other] || 0) + 1; if (!current) renderContacts(); }
    }
  };
  ws.onclose = () => { setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000)); };
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && ws?.readyState !== 1) { ws?.close(); connect(); } });

syncSend();
start();
