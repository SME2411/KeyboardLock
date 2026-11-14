const $ = (id) => document.getElementById(id);
let me, users = [], current = null, ws, onlineIds = [], oldest = 0, registering = false, retry = 0;

const api = async (path, opts) => {
  const r = await fetch(path, opts && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) });
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
$('logout').onclick = async () => { await api('/api/logout', {}); ws?.close(); location.reload(); };

async function start() {
  try { me = await api('/api/me'); } catch { $('auth').hidden = false; $('app').hidden = true; return; }
  $('auth').hidden = true; $('app').hidden = false;
  users = await api('/api/users');
  renderContacts();
  connect();
  if (users.length === 1) openChat(users[0]);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
}

// ---------- контакты ----------
function renderContacts() {
  $('contacts').innerHTML = '';
  if (!users.length) $('contacts').textContent = 'Пока никого нет. Пусть второй человек зарегистрируется.';
  for (const u of users) {
    const d = document.createElement('div'); d.className = 'contact';
    d.innerHTML = `<span></span><span class="dot">${onlineIds.includes(u.id) ? '● онлайн' : ''}</span>`;
    d.firstChild.textContent = u.username;
    d.onclick = () => openChat(u);
    $('contacts').append(d);
  }
}
$('back').onclick = () => { current = null; $('chat').hidden = true; $('contacts').hidden = false; $('back').hidden = true; $('title').textContent = 'Чат'; $('status').textContent = ''; };

// ---------- чат ----------
async function openChat(u) {
  current = u; $('contacts').hidden = true; $('chat').hidden = false; $('back').hidden = users.length === 1;
  $('title').textContent = u.username; updateStatus();
  $('messages').innerHTML = ''; oldest = 0;
  const list = await api('/api/messages?with=' + u.id);
  list.forEach((m) => addMsg(m)); scrollDown();
}
const updateStatus = () => { if (current) $('status').textContent = onlineIds.includes(current.id) ? 'онлайн' : 'не в сети'; };
let lastDay = '';
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
$('text').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !/Mobi|Android/i.test(navigator.userAgent)) { e.preventDefault(); sendText(); } };
function sendText() {
  const text = $('text').value.trim();
  if (!text || !current || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'msg', to: current.id, text }));
  $('text').value = '';
}

// ---------- websocket с автопереподключением ----------
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { retry = 0; if (current) openChat(current); }; // подтянуть пропущенное
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'presence') { onlineIds = d.online; renderContacts(); updateStatus(); }
    if (d.type === 'msg') {
      const other = d.msg.from_id === me.id ? d.msg.to_id : d.msg.from_id;
      const viewing = current?.id === other;
      if (viewing) { addMsg(d.msg); scrollDown(); }
      if (d.msg.from_id !== me.id && (!viewing || document.hidden)) notify(d.msg);
    }
  };
  ws.onclose = () => { setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000)); };
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && ws?.readyState !== 1) { ws?.close(); connect(); } });

function notify(m) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') Notification.requestPermission();
  if (Notification.permission === 'granted') {
    const from = users.find((u) => u.id === m.from_id)?.username || 'Сообщение';
    new Notification(from, { body: m.text, icon: '/icon.svg' });
  }
}

start();
