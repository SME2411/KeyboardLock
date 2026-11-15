const $ = (id) => document.getElementById(id);
let me, users = [], current = null, ws, onlineIds = [], registering = false, retry = 0, typingTimer = null, isTyping = false;
const unread = {};

const api = async (path, body) => {
  const r = await fetch(path, body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Ошибка'), { status: r.status });
  return data;
};

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
$('logout').onclick = async () => {
  try { const reg = await navigator.serviceWorker?.ready; const s = await reg?.pushManager.getSubscription();
    if (s) { await api('/api/push/unsubscribe', { endpoint: s.endpoint }); await s.unsubscribe(); } } catch {}
  await api('/api/logout', {}); ws?.close(); location.reload();
};

async function start() {
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

// ---------- аватарки: цвет зависит от имени ----------
function setAvatar(el, name, on) {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  el.style.setProperty('--h1', `hsl(${h} 85% 66%)`); el.style.setProperty('--h2', `hsl(${(h + 40) % 360} 80% 58%)`);
  el.textContent = name[0].toUpperCase(); el.classList.toggle('on', !!on);
}

// ---------- push-уведомления ----------
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function showBanner(text, withBtn) {
  $('banner').hidden = !text; $('bannerText').textContent = text || ''; $('bannerBtn').hidden = !withBtn;
}
function updateBanner() {
  if (!pushSupported()) {
    if (isIOS() && !isStandalone()) showBanner('Чтобы получать уведомления на iPhone: нажми «Поделиться» в Safari → «На экран «Домой»», затем открой DuoVerse с экрана.', false);
    else showBanner('', false);
  } else if (Notification.permission === 'granted') { showBanner('', false); subscribePush().catch(console.error); }
  else if (Notification.permission === 'denied') showBanner('Уведомления запрещены. Разреши их в настройках телефона или браузера.', false);
  else showBanner('Включи уведомления, чтобы не пропускать сообщения 🔔', true);
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
  if (!users.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'Пока никого нет 🌙 Пусть второй человек зарегистрируется.'; box.append(d); }
  users.forEach((u, i) => {
    const d = document.createElement('div'); d.className = 'contact'; d.style.animationDelay = i * 60 + 'ms';
    const av = document.createElement('div'); av.className = 'avatar'; setAvatar(av, u.username, onlineIds.includes(u.id));
    const name = document.createElement('span'); name.className = 'name'; name.textContent = u.username;
    d.append(av, name);
    if (unread[u.id]) { const b = document.createElement('span'); b.className = 'unread'; b.textContent = unread[u.id]; d.append(b); }
    d.onclick = () => openChat(u);
    box.append(d);
  });
}
$('back').onclick = () => {
  current = null; $('chat').hidden = true; $('contacts').hidden = false; $('back').hidden = true; $('avatar').hidden = true;
  $('title').textContent = 'DuoVerse'; $('status').textContent = ''; $('emoji').hidden = true; renderContacts();
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
let typingUntil = 0;
function updateStatus() {
  if (!current) return;
  const on = onlineIds.includes(current.id), st = $('status');
  $('avatar').classList.toggle('on', on);
  if (Date.now() < typingUntil) { st.textContent = 'печатает'; st.className = 'dots online'; }
  else { st.className = on ? 'online' : ''; st.textContent = on ? 'онлайн' : 'не в сети'; }
}
const segmenter = 'Segmenter' in Intl ? new Intl.Segmenter() : null;
function isBigEmoji(text) {
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
ta.addEventListener('input', () => {
  autosize();
  if (current && ws?.readyState === 1 && !isTyping) {   // не чаще раза в 2 секунды
    isTyping = true; ws.send(JSON.stringify({ type: 'typing', to: current.id }));
    setTimeout(() => { isTyping = false; }, 2000);
  }
});
$('composer').onsubmit = (e) => { e.preventDefault(); sendText(); };
ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !/Mobi|Android|iPhone/i.test(navigator.userAgent)) { e.preventDefault(); sendText(); } };
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
      if (d.online.some((id) => id !== me.id && !users.some((u) => u.id === id))) refreshUsers();
      else { if (!current) renderContacts(); updateStatus(); }
    }
    if (d.type === 'typing' && current?.id === d.from) {
      typingUntil = Date.now() + 3000; updateStatus();
      clearTimeout(typingTimer); typingTimer = setTimeout(updateStatus, 3100);
    }
    if (d.type === 'msg') {
      const other = d.msg.from_id === me.id ? d.msg.to_id : d.msg.from_id;
      if (current?.id === other) {
        typingUntil = 0; updateStatus();
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
