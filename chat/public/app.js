import { THEMES } from '/themes.js';
const $ = (id) => document.getElementById(id);
const drafts = JSON.parse(localStorage.getItem('duoverse.drafts') || '{}');
let me, chats = [], current = null, ws, onlineIds = [], registering = false, retry = 0, actTimer = null, lastActSent = 0;

const api = (path, body) => apiReq(body ? 'POST' : 'GET', path, body);
const apiReq = async (method, path, body) => {
  const r = await fetch(path, method === 'GET' ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Ошибка'), { status: r.status });
  return data;
};

// ---------- настройки (хранятся на устройстве) ----------
const DEFAULTS = { mode: 'system', style: 'graphite', anim: 'full', emojiAnim: true, bigEmoji: true, fontSize: 'm', enterSends: true, showTyping: true, compress: true, wall: 'doodle', wallDim: 0, wallBlur: false, radius: 17 };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('duoverse.settings') || '{}') }; } catch {}
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function applySettings() {
  const r = document.documentElement;
  const dark = settings.mode === 'dark' || (settings.mode === 'system' && darkMq.matches);
  r.dataset.mode = dark ? 'dark' : 'light'; r.dataset.style = settings.style; r.dataset.anim = settings.anim;
  r.dataset.emojiAnim = settings.emojiAnim ? 'on' : 'off'; r.dataset.fs = settings.fontSize; r.dataset.wall = settings.wall;
  const img = settings.wall === 'custom' ? localStorage.getItem('duoverse.wallpaperImg') : null;
  if (img) r.style.setProperty('--wall-custom', `url(${img})`); else r.style.removeProperty('--wall-custom');
  r.style.setProperty('--r', settings.radius + 'px');
  r.style.setProperty('--wall-dim', settings.wallDim / 100); r.style.setProperty('--wall-blur', (settings.wallBlur ? 8 : 0) + 'px');
  $('themeColor').content = getComputedStyle(r).getPropertyValue('--bg').trim() || '#ffffff';
}
function setSetting(k, v) { settings[k] = v; localStorage.setItem('duoverse.settings', JSON.stringify(settings)); applySettings(); }
darkMq.addEventListener('change', applySettings);

// ---------- кнопка «Назад»: каждое действие — отдельный шаг истории ----------
// Слои (чат на телефоне, панели, панель эмодзи, просмотр фото) кладутся в историю браузера,
// поэтому системная кнопка «Назад» / жест закрывает их по одному и не выходит из приложения.
const layers = [];                // [{ name, close }]; верхний — последний
let closingAll = false, exitTimer = null, historyReady = false, maxVV = 0;
const vv = window.visualViewport;
const pushLayer = (name, close) => { layers.push({ name, close }); history.pushState({ s: 'layer', d: layers.length }, ''); };
const topLayer = () => layers[layers.length - 1]?.name;
const hasLayer = (name) => layers.some((l) => l.name === name);
const backLayer = () => { if (layers.length) history.back(); };           // закрыть верхний слой через историю
function closeLayers(name) {                                                // закрыть слой name и всё, что над ним, одним переходом
  const i = layers.findIndex((l) => l.name === name); if (i < 0) return;
  closingAll = true; history.go(-(layers.length - i));
}
function toast(text, ms = 2200) {
  const t = $('toast'); t.textContent = text; t.hidden = false; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 250); }, ms);
}
// клавиатура на телефоне открыта, если видимая область заметно ниже максимальной
if (vv) { const upd = () => { maxVV = Math.max(maxVV, vv.height); }; vv.addEventListener('resize', upd); upd(); addEventListener('orientationchange', () => { maxVV = vv.height; }); }
const keyboardOpen = () => !!vv && maxVV - vv.height > 120;
// двойное «Назад» для выхода нужно только на телефонах/в установленном приложении; на iPhone выхода по «Назад» нет вообще
const guardEnabled = () => !/iPhone|iPad|iPod/.test(navigator.userAgent) && (matchMedia('(display-mode: standalone)').matches || /Mobi|Android/i.test(navigator.userAgent));
function initHistory() {
  if (historyReady) return; historyReady = true;
  const st = history.state;
  if (typeof st?.d === 'number' && st.d > 0) { history.go(-st.d); return; }   // после перезагрузки внутри «слоёв» вернёмся к корню
  if (guardEnabled()) {
    if (st?.s === 'base') history.pushState({ s: 'root', d: 0 }, '');
    else if (st?.s !== 'root') { history.replaceState({ s: 'base', d: -1 }, ''); history.pushState({ s: 'root', d: 0 }, ''); }
  } else if (st?.s !== 'root') history.replaceState({ s: 'root', d: 0 }, '');
}
addEventListener('popstate', (e) => {
  const st = e.state || {};
  if (st.s === 'base') {            // дно истории: просим подтвердить выход
    if (guardEnabled()) {
      toast('Нажмите «Назад» ещё раз, чтобы выйти');
      clearTimeout(exitTimer); exitTimer = setTimeout(() => history.pushState({ s: 'root', d: 0 }, ''), 2300);
    }
    return;
  }
  const target = typeof st.d === 'number' ? st.d : 0;
  // с открытой клавиатурой первое «Назад» убирает клавиатуру, а не уходит из чата
  if (layers.length > target && topLayer() === 'chat' && keyboardOpen() && document.activeElement === ta) {
    ta.blur(); history.pushState({ s: 'layer', d: layers.length }, ''); return;
  }
  while (layers.length > target) layers.pop().close();
  closingAll = false;
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && layers.length && topLayer() !== 'chat') backLayer(); });

// ---------- боковая панель (настройки, профиль) ----------
const sheetStack = [];   // перестройщики открытых окон: «Назад» из вложенного возвращает в предыдущее (настройки → устройства)
function openSheet(title, rebuild, fromBack) {
  if (fromBack !== true) {
    sheetStack.push(rebuild);
    pushLayer('sheet', () => {
      sheetStack.pop(); const prev = sheetStack[sheetStack.length - 1];
      if (prev && !closingAll) prev(true); else if (!prev) $('settings').hidden = true;
    });
  }
  const sh = $('sheet'); sh.innerHTML = '';
  const head = document.createElement('div'); head.className = 'sheet-head';
  const h = document.createElement('h2'); h.textContent = title;
  const x = document.createElement('button'); x.className = 'icon-btn'; x.textContent = '✕'; x.setAttribute('aria-label', 'Закрыть'); x.onclick = closeSettings;
  head.append(h, x); sh.append(head); $('settings').hidden = false; return sh;
}
const closeSettings = () => closeLayers('sheet');
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const section = (sh, text) => sh.append(mk('div', 'sec', text));
function segRow(sh, k, label, opts, onChange) {
  const row = mk('div', 'row'); row.append(mk('div', '', label));
  const seg = mk('div', 'seg');
  for (const [val, text] of opts) {
    const b = mk('button', '', text); b.type = 'button'; b.classList.toggle('active', settings[k] === val);
    b.onclick = () => { setSetting(k, val); [...seg.children].forEach((c) => c.classList.toggle('active', c === b)); onChange?.(); };
    seg.append(b);
  }
  row.append(seg); sh.append(row);
}
function switchRow(sh, k, label, hint, onChange) {
  const row = mk('div', 'row inline'), lab = mk('div', '', label);
  if (hint) lab.append(mk('small', '', hint));
  const sw = mk('button', 'sw'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!settings[k]));
  sw.onclick = () => { setSetting(k, !settings[k]); sw.setAttribute('aria-checked', String(!!settings[k])); onChange?.(); };
  row.append(lab, sw); sh.append(row);
}
const isDarkNow = () => document.documentElement.dataset.mode === 'dark';

const WALLS = [['doodle', 'Узор'], ['dots', 'Точки'], ['grid', 'Сетка'], ['g1', 'Градиент 1'], ['g2', 'Градиент 2'], ['g3', 'Градиент 3'], ['none', 'Без фона'], ['custom', 'Своё фото']];
function openSettings(fromBack) {
  const sh = openSheet('Настройки', openSettings, fromBack === true);
  section(sh, 'Оформление');
  segRow(sh, 'mode', 'Режим', [['system', 'Как в телефоне'], ['light', 'Светлый'], ['dark', 'Тёмный']], () => { renderThemes(); });
  const trow = mk('div', 'row'); trow.append(mk('div', '', 'Тема')); sh.append(trow);
  const gal = mk('div', 'themes'); sh.append(gal);
  function renderThemes() {
    gal.innerHTML = '';
    for (const t of THEMES) {
      const b = mk('button', 'theme' + (settings.style === t.id ? ' active' : '')); b.type = 'button';
      const c = isDarkNow() ? t.dark : t.light, sw = document.createElement('i');
      sw.style.background = `linear-gradient(135deg, ${c.bg} 50%, ${c.acc} 50%)`;
      b.append(sw, mk('span', '', t.name)); b.onclick = () => { setSetting('style', t.id); renderThemes(); renderWalls(); }; gal.append(b);
    }
  }
  renderThemes();
  segRow(sh, 'fontSize', 'Размер текста', [['s', 'Мелкий'], ['m', 'Обычный'], ['l', 'Крупный']]);
  const rrow = mk('div', 'row'); rrow.append(mk('div', '', 'Скругление сообщений'));
  const rr = document.createElement('input'); rr.type = 'range'; rr.min = 4; rr.max = 26; rr.value = settings.radius;
  rr.oninput = () => setSetting('radius', Number(rr.value)); rrow.append(rr); sh.append(rrow);

  section(sh, 'Обои чата');
  const wgrid = mk('div', 'walls'); sh.append(wgrid);
  const fileIn = document.createElement('input'); fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.hidden = true; sh.append(fileIn);
  function renderWalls() {
    wgrid.innerHTML = '';
    for (const [id, name] of WALLS) {
      const b = mk('button', 'wall' + (settings.wall === id ? ' active' : '')); b.type = 'button';
      const prev = document.createElement('i'); prev.dataset.w = id; b.append(prev, mk('span', '', name));
      // превью каждого обоя: временно подменяем переменные только внутри кнопки
      b.dataset.wall = id; b.onclick = () => { if (id === 'custom') { fileIn.click(); return; } setSetting('wall', id); renderWalls(); };
      wgrid.append(b);
    }
  }
  renderWalls();
  fileIn.onchange = async () => {
    const f = fileIn.files[0]; if (!f) return;
    try { localStorage.setItem('duoverse.wallpaperImg', await resizeToDataUrl(f, 1600, 0.82)); setSetting('wall', 'custom'); renderWalls(); }
    catch (e) { alert('Не удалось поставить фон: ' + (e.name === 'QuotaExceededError' ? 'слишком большое фото' : 'неподдерживаемая картинка')); }
    fileIn.value = '';
  };
  const drow = mk('div', 'row'); drow.append(mk('div', '', 'Затемнение фона'));
  const rng = document.createElement('input'); rng.type = 'range'; rng.min = 0; rng.max = 70; rng.value = settings.wallDim;
  rng.oninput = () => setSetting('wallDim', Number(rng.value)); drow.append(rng); sh.append(drow);
  switchRow(sh, 'wallBlur', 'Размытие фона', 'Хорошо для яркого своего фото');

  section(sh, 'Анимации');
  segRow(sh, 'anim', 'Анимации', [['full', 'Полные'], ['min', 'Минимум'], ['off', 'Выкл']]);
  switchRow(sh, 'emojiAnim', 'Анимация эмодзи', 'Крупные эмодзи «подпрыгивают» при получении');
  switchRow(sh, 'bigEmoji', 'Крупные эмодзи', '1–3 эмодзи показываются без пузырька', () => { if (current) openChat(current); });

  section(sh, 'Чат');
  switchRow(sh, 'enterSends', 'Enter отправляет', 'На компьютере; Shift+Enter — новая строка');
  switchRow(sh, 'showTyping', 'Показывать, что я печатаю', 'Если выключить, собеседник не увидит «печатает…»');
  switchRow(sh, 'compress', 'Сжимать фото при отправке', 'Меньше трафика, и пропадают метаданные (в т.ч. место съёмки)');

  section(sh, 'Уведомления и аккаунт');
  const nrow = mk('div', 'row inline'), nl = mk('div', '', 'Push-уведомления'), nh = mk('small'); nl.append(nh);
  const nb = mk('button', 'btn'); nrow.append(nl, nb); sh.append(nrow); refreshPushRow(nh, nb);
  const drow2 = mk('div', 'row inline'); drow2.append(mk('div', '', 'Устройства'));
  const db = mk('button', 'btn', 'Открыть'); db.onclick = openDevices; drow2.append(db); sh.append(drow2);
  const srow = mk('div', 'row inline'), sl = mk('div', '', 'Данные на устройстве'), sn = mk('small', '', 'считаем…'); sl.append(sn);
  const sb = mk('button', 'btn', 'Очистить'); srow.append(sl, sb); sh.append(srow);
  localUsage().then((t) => { sn.textContent = t; });
  sb.onclick = async () => {
    if (!confirm('Удалить фон-фото, недавние эмодзи и черновики на этом устройстве? Вход и настройки останутся.')) return;
    localStorage.removeItem('duoverse.wallpaperImg'); localStorage.removeItem('recentEmoji'); localStorage.removeItem('duoverse.drafts');
    if (settings.wall === 'custom') setSetting('wall', 'doodle');
    try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
    Object.keys(drafts).forEach((k) => delete drafts[k]); renderChats(); sn.textContent = await localUsage();
  };
  const prow = mk('div', 'row inline'); prow.append(mk('div', '', 'Мой профиль'));
  const pb = mk('button', 'btn', 'Открыть'); pb.onclick = openProfile; prow.append(pb); sh.append(prow);
  const arow = mk('div', 'row inline'); arow.append(mk('div', '', 'Вы вошли как ' + me.username));
  const lo = mk('button', 'btn danger', 'Выйти'); lo.onclick = logout; arow.append(lo); sh.append(arow);
  sh.append(mk('div', 'pad'));
}
$('sheetBg').onclick = closeSettings;
$('settingsBtn').onclick = openSettings;

// уменьшает картинку и отдаёт data-URL (для фона) или Blob (для аватарки)
async function resizeImage(file, max, quality, square) {
  const bmp = await createImageBitmap(file);
  let sw = bmp.width, sh = bmp.height, sx = 0, sy = 0;
  if (square) { const m = Math.min(sw, sh); sx = (sw - m) / 2; sy = (sh - m) / 2; sw = sh = m; }
  const k = Math.min(1, max / Math.max(sw, sh)), cw = Math.round(sw * k), ch = Math.round(sh * k);
  const c = document.createElement('canvas'); c.width = cw; c.height = ch; c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, cw, ch);
  bmp.close?.(); return new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
}
async function resizeToDataUrl(file, max, quality) {
  const blob = await resizeImage(file, max, quality, false);
  return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
}

// ---------- устройства (сеансы) ----------
async function localUsage() {
  let bytes = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); bytes += (k.length + (localStorage.getItem(k) || '').length) * 2; }
  let est = ''; try { const e = await navigator.storage?.estimate?.(); if (e?.usage) est = ` · браузерный кэш ≈ ${fmtSize(e.usage)}`; } catch {}
  return `${fmtSize(bytes)} в приложении${est}`;
}
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 2) return 'сейчас'; if (m < 60) return `${m} мин назад`;
  const d = new Date(ts), now = new Date(), t = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `сегодня в ${t}`;
  if (new Date(now - 864e5).toDateString() === d.toDateString()) return `вчера в ${t}`;
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
};
async function openDevices(fromBack) {
  const sh = openSheet('Устройства', openDevices, fromBack === true);
  const list = await api('/api/sessions');
  sh.append(mk('div', 'prof-sub', 'Здесь все устройства, где выполнен вход в ваш аккаунт. Незнакомое можно завершить.'));
  const wrap = mk('div', 'devs'); sh.append(wrap);
  for (const d of list) {
    const row = mk('div', 'row inline dev');
    const lab = mk('div', '', d.device + (d.current ? '  (это устройство)' : '')); lab.append(mk('small', '', 'активность: ' + ago(d.last_active)));
    row.append(lab);
    if (!d.current) {
      const b = mk('button', 'btn danger', 'Завершить'); b.onclick = async () => { await apiReq('DELETE', '/api/sessions?id=' + d.id); openDevices(true); }; row.append(b);
    }
    wrap.append(row);
  }
  if (list.length > 1) {
    const rb = mk('div', 'rowbtn'); const all = mk('button', 'btn danger', 'Завершить все остальные'); all.onclick = async () => { if (confirm('Выйти со всех устройств, кроме этого?')) { await apiReq('DELETE', '/api/sessions?others=1'); openDevices(true); } };
    rb.append(all); sh.append(rb);
  }
  sh.append(mk('div', 'pad'));
}

// ---------- профиль ----------
const COVERS = { c1: ['#334155', '#64748b'], c2: ['#0f766e', '#2dd4bf'], c3: ['#1d4ed8', '#60a5fa'], c4: ['#4338ca', '#a5b4fc'], c5: ['#7c2d12', '#fb923c'], c6: ['#14532d', '#86efac'], c7: ['#111827', '#6b7280'], c8: ['#854d0e', '#fde047'], c9: ['#3f3f46', '#a1a1aa'] };
const coverCss = (id) => COVERS[id] ? `linear-gradient(135deg, ${COVERS[id][0]}, ${COVERS[id][1]})` : '';
const dispName = (u) => u.display_name || u.username;
function fillAvatar(el, u) {   // фото, если есть, иначе первая буква
  el.style.backgroundImage = ''; el.classList.remove('img'); el.textContent = dispName(u)[0].toUpperCase();
  if (u.avatar_v) { el.style.backgroundImage = `url(/api/avatar/${u.id}?v=${u.avatar_v})`; el.classList.add('img'); }
}
function openProfile(fromBack) {
  const sh = openSheet('Мой профиль', openProfile, fromBack === true);
  const draft = { display_name: me.display_name || '', bio: me.bio || '', cover: me.cover || '' };
  const cover = mk('div', 'prof-cover'); cover.style.setProperty('--cover', coverCss(draft.cover) || ''); if (!draft.cover) cover.style.removeProperty('--cover');
  const av = mk('div', 'avatar prof-av'); fillAvatar(av, me);
  const cam = mk('button', 'cam'); cam.type = 'button'; cam.setAttribute('aria-label', 'Сменить фото');
  cam.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/></svg>';
  av.append(cam);
  const fin = document.createElement('input'); fin.type = 'file'; fin.accept = 'image/*'; fin.hidden = true;
  cam.onclick = () => fin.click();
  fin.onchange = async () => {
    const f = fin.files[0]; if (!f) return;
    try {
      const blob = await resizeImage(f, 384, 0.88, true);
      const r = await fetch('/api/avatar', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      if (!r.ok) throw new Error((await r.json()).error || 'Ошибка');
    } catch (e) { alert('Фото не поставилось: ' + e.message); }
    fin.value = '';
  };
  sh.append(cover, av, fin);
  sh.append(mk('div', 'prof-sub', '@' + me.username));
  const nameIn = Object.assign(document.createElement('input'), { maxLength: 30, placeholder: me.username, value: draft.display_name });
  const bioIn = Object.assign(document.createElement('textarea'), { maxLength: 140, rows: 3, placeholder: 'Пара слов о себе', value: draft.bio });
  const l1 = mk('label', 'fld', 'Имя'); l1.append(nameIn); const l2 = mk('label', 'fld', 'О себе'); l2.append(bioIn); sh.append(l1, l2);
  section(sh, 'Цвет профиля');
  const covers = mk('div', 'covers'); sh.append(covers);
  const renderCovers = () => { covers.innerHTML = '';
    for (const id of ['', ...Object.keys(COVERS)]) {
      const b = mk('button', 'cover' + (draft.cover === id ? ' active' : '')); b.type = 'button';
      b.style.background = id ? coverCss(id) : 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 50%, var(--bg)))';
      b.onclick = () => { draft.cover = id; if (id) cover.style.setProperty('--cover', coverCss(id)); else cover.style.removeProperty('--cover'); renderCovers(); };
      covers.append(b);
    } };
  renderCovers();
  const btns = mk('div', 'rowbtn');
  const del = mk('button', 'btn', 'Убрать фото'); del.type = 'button'; del.onclick = async () => { await apiReq('DELETE', '/api/avatar'); };
  const save = mk('button', 'primary', 'Сохранить'); save.type = 'button';
  save.onclick = async () => {
    save.disabled = true;
    try { await apiReq('PUT', '/api/me', { display_name: nameIn.value, bio: bioIn.value, cover: draft.cover }); closeSettings(); }
    catch (e) { alert('Не сохранилось: ' + e.message); save.disabled = false; }
  };
  btns.append(del, save); sh.append(btns, mk('div', 'pad'));
  // фото обновляется «вживую»: когда сервер подтвердит, перерисуем
  profileRefresh = () => { fillAvatar(av, me); av.append(cam); };
}
let profileRefresh = null;
function openUserCard(c, fromBack) {   // профиль собеседника, только просмотр
  const sh = openSheet('Профиль', (fb) => openUserCard(c, fb), fromBack === true);
  const cover = mk('div', 'prof-cover'); if (c.cover && coverCss(c.cover)) cover.style.setProperty('--cover', coverCss(c.cover));
  const av = mk('div', 'avatar prof-av'); fillAvatar(av, c);
  sh.append(cover, av, mk('div', 'prof-name', dispName(c)), mk('div', 'prof-sub', '@' + c.username), mk('div', 'prof-sub', seenText(c)));
  if (c.bio) sh.append(mk('div', 'prof-bio', c.bio));
  sh.append(mk('div', 'pad'));
}
$('meBtn').onclick = openProfile;
$('whoBtn').onclick = () => { if (current?.kind === 'user') openUserCard(current); else if (current?.kind === 'self') openProfile(); };

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
  initHistory();
  paintMe();
  await loadChats();
  connect();
  updateBanner();
  buildEmoji();
}

function paintMe() { fillAvatar($('meAv'), me); }
// ---------- чаты: собеседники, «Избранное» (чат с собой), служебный «DuoVerse» ----------
const BOT_WELCOME = [
  'Добро пожаловать в DuoVerse 👋\nЭто ваш личный мессенджер на двоих: без посторонних и без рекламы.',
  'Что здесь умеет:\n• сообщения в реальном времени\n• фото, видео, аудио и файлы до 100 МБ\n• эмодзи и статусы «в сети», «печатает…»\n• уведомления, даже когда приложение закрыто',
  '«Избранное» — чат с самим собой для заметок, ссылок и файлов. Там удобно пробовать любые функции.',
  'Уведомления на iPhone: в Safari нажмите «Поделиться» → «На экран «Домой»», затем открывайте DuoVerse с экрана.',
  'Внешний вид, тема и анимации настраиваются кнопкой ⚙ в списке чатов.',
];
const botChat = () => ({ id: -1, username: 'DuoVerse', name: 'DuoVerse', kind: 'bot', unread: localStorage.getItem('welcomeSeen') ? 0 : 1, last: null });
const toChat = (u) => ({ ...u, peerRead: u.peer_read || 0, kind: u.self ? 'self' : 'user', name: u.self ? 'Избранное' : (u.display_name || u.username) });
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
  const small = el.classList.contains('sm');
  el.className = 'avatar' + (small ? ' sm' : ''); el.textContent = ''; el.style.backgroundImage = '';
  if (c.kind === 'self') { el.classList.add('ic'); el.innerHTML = BOOKMARK; }
  else if (c.kind === 'bot') { el.classList.add('mono-av'); el.textContent = 'D'; }
  else { fillAvatar(el, c); el.classList.toggle('on', onlineIds.includes(c.id)); }
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
  if (drafts[c.id] && current?.id !== c.id) return null;   // черновик показываем отдельным оформлением
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
    const pv = document.createElement('span'); pv.className = 'pv' + (c.kind === 'user' && activeAction(c.id) ? ' live' : '');
    const pt = previewOf(c);
    if (pt === null) { const dl = mk('span', 'draft', 'Черновик: '); pv.append(dl, drafts[c.id].slice(0, 80)); } else pv.textContent = pt;
    l2.append(pv);
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
const narrow = () => matchMedia('(max-width: 799px)').matches;
function leaveChatView() {
  current = null; $('app').dataset.view = 'list'; $('chat').hidden = true; $('empty').hidden = false;
  closeEmojiUI(); renderChats();
}
$('back').onclick = () => (hasLayer('chat') ? closeLayers('chat') : leaveChatView());

// ---------- чат ----------
let lastDay = '', lastFrom = null, lastTime = 0, openSeq = 0, lastRendered = 0;
const seen = new Set();   // id уже показанных сообщений: защита от дублей
async function openChat(c) {
  const my = ++openSeq;
  if (narrow() && !hasLayer('chat')) pushLayer('chat', leaveChatView);   // на телефоне чат — отдельный шаг «Назад»
  current = c; $('app').dataset.view = 'chat'; $('empty').hidden = true; $('chat').hidden = false;
  setAvatar($('avatar'), c); $('title').textContent = c.name; updateStatus();
  const bot = c.kind === 'bot';
  $('composer').hidden = bot; $('readonly').hidden = !bot; if (bot) $('emoji').hidden = true;
  ta.value = bot ? '' : (drafts[c.id] || ''); autosize();
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
  el.dataset.mid = m.id;
  if (m.from_id === me.id && current?.kind === 'user') { const k = mk('span', 'tick', ''); t.append(' ', k); }
  el.append(t); box.append(el); updateTicks();
}
function updateTicks() {   // ✓ отправлено, ✓✓ прочитано собеседником
  if (current?.kind !== 'user') return;
  for (const k of document.querySelectorAll('.msg.me .tick')) {
    const read = Number(k.closest('.msg').dataset.mid) <= (current.peerRead || 0);
    k.textContent = read ? '✓✓' : '✓'; k.classList.toggle('read', read);
  }
}
const scrollDown = (smooth = true) => { const b = $('messages'); b.style.scrollBehavior = smooth ? 'smooth' : 'auto'; b.scrollTop = b.scrollHeight; };

// ---------- ввод ----------
const ta = $('text');
function syncSend() { $('sendBtn').classList.toggle('idle', !ta.value.trim()); }
function autosize() {   // высота = содержимое + рамка (иначе внутри остаётся лишние 2px и появляется полоса прокрутки)
  ta.style.height = 'auto';
  const need = ta.scrollHeight + (ta.offsetHeight - ta.clientHeight);
  ta.style.height = Math.min(need, 130) + 'px'; ta.style.overflowY = need > 130 ? 'auto' : 'hidden';
  syncSend(); saveDraft();
}
function saveDraft() {   // черновик у каждого чата свой, переживает перезагрузку
  if (!current || current.kind === 'bot') return;
  const t = ta.value; if (t.trim()) drafts[current.id] = t; else delete drafts[current.id];
  localStorage.setItem('duoverse.drafts', JSON.stringify(drafts));
}
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
  ta.value = ''; delete drafts[current.id]; autosize();   // фокус не трогаем: клавиатура остаётся как была
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
  pushLayer('lightbox', () => { lb.hidden = true; });
}
$('lightbox').onclick = (e) => { if (e.target.id !== 'lbDl' && topLayer() === 'lightbox') backLayer(); };

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
    if ($('emoji').hidden) {            // открыть панель: клавиатуру убираем, чтобы они не лежали друг на друге
      ta.blur(); $('emoji').hidden = false; $('emojiBtn').textContent = '⌨️';
      show(recent().length ? '🕘' : '😊'); pushLayer('emoji', closeEmojiUI);
    } else { if (topLayer() === 'emoji') backLayer(); ta.focus(); }    // обратно к клавиатуре
    setTimeout(() => scrollDown(false), 60);
  };
}
function closeEmojiUI() { $('emoji').hidden = true; $('emojiBtn').textContent = '😊'; }
// когда пользователь нажал на поле ввода и открылась клавиатура, панель эмодзи убираем
$('text').addEventListener('focus', () => { if (!$('emoji').hidden && topLayer() === 'emoji') backLayer(); });
// кнопка «Отправить» не отнимает фокус у поля: клавиатура не прыгает ни туда, ни обратно
$('sendBtn').addEventListener('pointerdown', (e) => e.preventDefault());

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
    if (d.type === 'read') {   // собеседник прочитал наши сообщения
      const c = chats.find((x) => x.id === d.by); if (c) { c.peerRead = Math.max(c.peerRead || 0, d.upto); if (current?.id === c.id) updateTicks(); }
    }
    if (d.type === 'profile') {   // кто-то поменял имя, фото или «о себе»
      const u = d.user;
      if (u.id === me.id) { me = { ...me, ...u }; paintMe(); profileRefresh?.(); }
      const c = chats.find((x) => x.id === u.id && x.kind !== 'bot');
      if (c) { Object.assign(c, u); if (c.kind === 'user') c.name = dispName(u); if (current?.id === c.id) { $('title').textContent = c.name; setAvatar($('avatar'), c); } }
      renderChats();
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
