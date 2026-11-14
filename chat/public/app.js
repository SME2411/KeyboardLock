const $ = (id) => document.getElementById(id);
let me, users = [], current = null, ws, onlineIds = [], registering = false, retry = 0;
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
  if (users.length === 1) openChat(users[0]);
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
  else showBanner('Включи уведомления, чтобы не пропускать сообщения.', true);
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
  await api('/api/push/subscribe', sub.toJSON());   // повторная отправка безопасна: сервер обновит запись
}

// ---------- контакты ----------
async function refreshUsers() {
  users = await api('/api/users');
  if (!current && users.length === 1) openChat(users[0]);
  else { if (!current) renderContacts(); updateStatus(); }
}
function renderContacts() {
  $('contacts').innerHTML = '';
  if (!users.length) $('contacts').textContent = 'Пока никого нет. Пусть второй человек зарегистрируется.';
  for (const u of users) {
    const d = document.createElement('div'); d.className = 'contact';
    const name = document.createElement('span'); name.textContent = u.username;
    const right = document.createElement('span');
    if (unread[u.id]) { const b = document.createElement('span'); b.className = 'unread'; b.textContent = unread[u.id]; right.append(b, ' '); }
    if (onlineIds.includes(u.id)) { const o = document.createElement('span'); o.className = 'dot'; o.textContent = '● онлайн'; right.append(o); }
    d.append(name, right);
    d.onclick = () => openChat(u);
    $('contacts').append(d);
  }
}
$('back').onclick = () => { current = null; $('chat').hidden = true; $('contacts').hidden = false; $('back').hidden = true; $('title').textContent = 'DuoVerse'; $('status').textContent = ''; renderContacts(); };

// ---------- чат ----------
let lastDay = '';
async function openChat(u) {
  current = u; unread[u.id] = 0;
  $('contacts').hidden = true; $('chat').hidden = false; $('back').hidden = users.length === 1;
  $('title').textContent = u.username; updateStatus();
  $('messages').innerHTML = ''; lastDay = '';
  const list = await api('/api/messages?with=' + u.id);
  list.forEach(addMsg); scrollDown();
}
const updateStatus = () => { if (current) $('status').textContent = onlineIds.includes(current.id) ? 'онлайн' : 'не в сети'; };
function addMsg(m) {
  const box = $('messages'), d = new Date(m.created_at), day = d.toLocaleDateString('ru');
  if (day !== lastDay) { const s = document.createElement('div'); s.className = 'day'; s.textContent = day; box.append(s); lastDay = day; }
  const el = document.createElement('div'); el.className = 'msg' + (m.from_id === me.id ? ' me' : '');
  el.textContent = m.text;
  const t = document.createElement('time'); t.textContent = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  el.append(t); box.append(el);
}
const scrollDown = () => { $('messages').scrollTop = $('messages').scrollHeight; };

$('composer').onsubmit = (e) => { e.preventDefault(); sendText(); };
$('text').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !/Mobi|Android|iPhone/i.test(navigator.userAgent)) { e.preventDefault(); sendText(); } };
function sendText() {
  const text = $('text').value.trim();
  if (!text || !current || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'msg', to: current.id, text }));
  $('text').value = '';
}

// ---------- websocket с автопереподключением ----------
// Сообщаем серверу, смотрим ли мы сейчас в приложение: если нет, он пришлёт push.
const isVisible = () => !document.hidden && document.hasFocus();
const sendVis = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'vis', visible: isVisible() })); };
['visibilitychange', 'focus', 'blur'].forEach((ev) => addEventListener(ev, sendVis));

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { retry = 0; sendVis(); if (current) openChat(current); };  // подтянуть пропущенное
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'presence') {
      onlineIds = d.online;
      // кто-то новый зарегистрировался и зашёл: обновляем список контактов
      if (d.online.some((id) => id !== me.id && !users.some((u) => u.id === id))) refreshUsers();
      else { if (!current) renderContacts(); updateStatus(); }
    }
    if (d.type === 'msg') {
      const other = d.msg.from_id === me.id ? d.msg.to_id : d.msg.from_id;
      if (current?.id === other) { addMsg(d.msg); scrollDown(); }
      else if (d.msg.from_id !== me.id) { unread[other] = (unread[other] || 0) + 1; if (!current) renderContacts(); }
    }
  };
  ws.onclose = () => { setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000)); };
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && ws?.readyState !== 1) { ws?.close(); connect(); } });

start();
