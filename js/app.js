'use strict';

/* ================== БАЗОВОЕ ================== */

const INTERVALS = [0, 1, 3, 7, 14]; // дней между повторениями для коробок 1..5
const SESSION_SIZE = 10;

const CLOUD = window.CLOUD || {};
const cloudEnabled = !!(CLOUD.url && CLOUD.key);

let profile = null;   // имя пользователя (сохраняется между визитами)
let dictWords = [];   // словарь (из облака; офлайн — из кэша/файлов)
let progress = {};    // id -> {box, correct, wrong, last_review}
let favorites = new Set(); // id избранных слов
let session = null;
let syncTimer = null;
let wordCardId = null;

// каталог
let activeCategory = '';
let viewMode = localStorage.getItem('erudit_view') || 'list';

// занятие: набор слов и режим теста
let studyScope = 'all';                 // 'all' | 'fav' | 'cats'
let selectedCats = new Set(load('erudit_scope_cats', []));

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch (e) { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

/* ================== ТЕМА ================== */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('erudit_theme', t);
  const b = $('#btn-theme');
  if (b) b.textContent = t === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

/* ================== ВЫДЕЛЕНИЕ СЛОВА В ПРИМЕРАХ ================== */

/** HTML-текст с <b> на всех встречах основы слова (с учётом склонений). */
function boldStem(text, word) {
  const w = String(word || '').toLowerCase();
  if (!w) return esc(text);
  const stem = w.length <= 5 ? w : w.slice(0, w.length - 2);
  const re = new RegExp(stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ё/g, '[её]'), 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index)) + '<b>' + esc(m[0]) + '</b>';
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + esc(text.slice(last));
}

function examplesHtml(w, cls) {
  if (!w.examples || !w.examples.length) return '';
  return `<ul class="${cls || 'examples'}">${w.examples.map((e) => `<li>${boldStem(e, w.word)}</li>`).join('')}</ul>`;
}

/* ================== ОБЛАКО (Supabase REST) ================== */

function cloudHeaders(extra = {}) {
  return {
    apikey: CLOUD.key,
    Authorization: 'Bearer ' + CLOUD.key,
    'Content-Type': 'application/json',
    ...extra
  };
}

/* ---- слова ---- */

function wordPayload(w) {
  return {
    id: w.id,
    word: w.word,
    stress: typeof w.stress === 'number' ? w.stress : null,
    category: w.category || '',
    meaning: w.meaning,
    etymology: w.etymology || '',
    examples: Array.isArray(w.examples) ? w.examples : []
  };
}

async function cloudGetWords() {
  const r = await fetch(`${CLOUD.url}/rest/v1/words?select=*&order=word.asc`, {
    headers: cloudHeaders()
  });
  if (!r.ok) throw new Error('cloud_words_failed');
  const rows = await r.json();
  return rows.map(normalizeWord);
}

async function cloudUpsertWord(w) {
  const r = await fetch(`${CLOUD.url}/rest/v1/words`, {
    method: 'POST',
    headers: cloudHeaders({ Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify(wordPayload(w))
  });
  if (!r.ok) throw new Error('cloud_write_failed');
}

async function cloudDeleteWord(id) {
  const r = await fetch(`${CLOUD.url}/rest/v1/words?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: cloudHeaders()
  });
  if (!r.ok) throw new Error('cloud_delete_failed');
}

/* ---- профили (прогресс + избранное) ---- */

async function cloudGet(name) {
  const key = name.toLowerCase();
  const r = await fetch(`${CLOUD.url}/rest/v1/profiles?select=*&name=eq.${encodeURIComponent(key)}`, {
    headers: cloudHeaders()
  });
  if (!r.ok) throw new Error('cloud_read_failed');
  const rows = await r.json();
  return rows[0] || null;
}

async function cloudUpsertProfile(row) {
  const r = await fetch(`${CLOUD.url}/rest/v1/profiles`, {
    method: 'POST',
    headers: cloudHeaders({ Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error('cloud_write_failed');
}

async function cloudSaveProfile(name) {
  const key = name.toLowerCase();
  const r = await fetch(`${CLOUD.url}/rest/v1/profiles?name=eq.${encodeURIComponent(key)}`, {
    method: 'PATCH',
    headers: cloudHeaders(),
    // колонка в таблице называется data (jsonb) — прогресс и избранное внутри неё
    body: JSON.stringify({
      data: { progress, favorites: [...favorites] },
      updated_at: new Date().toISOString()
    })
  });
  if (!r.ok) throw new Error('cloud_write_failed');
}

/* Отложенная выгрузка прогресса в облако */
function queueSync() {
  if (!cloudEnabled || !profile) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      await cloudSaveProfile(profile);
      $('#status').textContent = '☁ сохранено';
      setTimeout(() => renderStudy(), 1500);
    } catch (e) {
      console.warn('Облако недоступно, прогресс сохранён локально', e);
      $('#status').textContent = '☁ офлайн';
      setTimeout(() => renderStudy(), 1500);
    }
  }, 2000);
}

/* Слияние локального и облачного прогресса: побеждает более свежий ответ */
function mergeProgress(localProgress, cloudProgress) {
  const merged = { ...(cloudProgress || {}) };
  for (const [id, lp] of Object.entries(localProgress || {})) {
    const cp = merged[id];
    if (!cp || !cp.last_review || new Date(lp.last_review || 0) > new Date(cp.last_review || 0)) {
      merged[id] = lp;
    }
  }
  return merged;
}

/* ================== ПРОФИЛИ И СЕССИЯ ================== */

function profileKey(suffix) { return 'erudit_' + suffix + ':' + profile.toLowerCase(); }
function profileKeyOf(name, suffix) { return 'erudit_' + suffix + ':' + name.toLowerCase(); }

function loadSession() {
  profile = localStorage.getItem('erudit_profile');
}

function saveSession() {
  localStorage.setItem('erudit_profile', profile);
}

function logout() {
  session = null;
  localStorage.removeItem('erudit_profile');
  profile = null;
  showLogin();
}

async function login(name, pin) {
  if (cloudEnabled) {
    const key = name.trim().toLowerCase();
    const hash = await sha256(key + ':' + pin);
    const row = await cloudGet(key);

    if (!row) {
      const localProgress = load('erudit_progress_v1', null) || load(profileKeyOf(key, 'progress_v2'), {}) || {};
      await cloudUpsertProfile({
        name: key,
        pin_hash: hash,
        data: { progress: localProgress, favorites: [], display_name: name.trim() },
        updated_at: new Date().toISOString()
      });
    } else if (row.pin_hash !== hash) {
      throw new Error('Неверный ПИН для ника «' + name.trim() + '»');
    }

    const cloudData = (row && row.data) || {};
    const cloudProgress = cloudData.progress || {};
    const localProgress = load(profileKeyOf(key, 'progress_v2'), {});
    const merged = mergeProgress(localProgress, cloudProgress);

    const localFav = load(profileKeyOf(key, 'favorites'), []) || [];
    const cloudFav = cloudData.favorites || [];
    const mergedFav = [...new Set([...localFav, ...cloudFav])];

    profile = name.trim().slice(0, 30);
    saveSession();
    save(profileKey('progress_v2'), merged);
    save(profileKey('favorites'), mergedFav);
    progress = merged;
    favorites = new Set(mergedFav);

    try {
      await cloudSaveProfile(profile);
    } catch (e) {
      console.warn('Не удалось сразу синхронизировать, повторится при следующем ответе', e);
    }
  } else {
    profile = name.trim().slice(0, 30);
    saveSession();
    if (!localStorage.getItem(profileKey('progress_v2'))) {
      const oldProgress = load('erudit_progress_v1', null);
      if (oldProgress) save(profileKey('progress_v2'), oldProgress);
    }
  }

  loadState();
  enterApp();
}

function showLogin() {
  $('#login').hidden = false;
  $('#tabs').hidden = true;
  ['study', 'words', 'stats'].forEach((t) => { $('#tab-' + t).hidden = true; });
  $('#user-chip').textContent = '';

  $('#login-pin').hidden = !cloudEnabled;
  $('#login-hint').textContent = cloudEnabled
    ? 'Придумай ник и ПИН-код. С того же ника и ПИНА твой прогресс откроется на любом устройстве.'
    : 'Как тебя называть? Под этим именем сохранится твой прогресс на этом устройстве.';
}

function enterApp() {
  $('#login').hidden = true;
  $('#tabs').hidden = false;
  $('#user-chip').textContent = profile;
  switchTab('study');
  renderAll();
}

async function sha256(s) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('erudit:' + s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'x' + h.toString(16);
  }
}

/* ================== СЛОВАРЬ ================== */

function normalizeWord(w) {
  return {
    id: w.id || ('w:' + String(w.word).toLowerCase()),
    word: String(w.word),
    stress: typeof w.stress === 'number' ? w.stress : null,
    category: w.category || '',
    meaning: w.meaning,
    etymology: w.etymology || '',
    examples: Array.isArray(w.examples) ? w.examples : (w.example ? [w.example] : [])
  };
}

async function loadWords() {
  if (cloudEnabled) {
    try {
      dictWords = await cloudGetWords();
      save('erudit_words_cache', dictWords);
      await migrateLegacyCustomWords();
      return;
    } catch (e) {
      console.warn('Словарь из облака недоступен, беру локальную копию', e);
    }
  }
  const cached = load('erudit_words_cache', null);
  if (cached && cached.length) { dictWords = cached; return; }
  try {
    const a = await fetch('data/words.json').then((r) => r.json());
    const b = await fetch('data/words-2.json').then((r) => r.json()).catch(() => []);
    const c = await fetch('data/words-3.json').then((r) => r.json()).catch(() => []);
    dictWords = [...a, ...b, ...c].map(normalizeWord);
    save('erudit_words_cache', dictWords);
  } catch (e) {
    dictWords = [];
  }
}

async function migrateLegacyCustomWords() {
  const have = new Set(dictWords.map((w) => w.id));
  const sources = [load('erudit_custom_v1', []) || [], load(profileKey('custom_v2'), []) || []];
  const missing = [];
  sources.forEach((arr) => (arr || []).forEach((w) => {
    if (w && w.word && w.meaning && !have.has(w.id)) { missing.push(w); have.add(w.id); }
  }));
  for (const w of missing) {
    try { await cloudUpsertWord(w); } catch (e) { console.warn('Не перенеслось:', w.word, e); }
  }
  if (missing.length) {
    dictWords = dictWords.concat(missing.map(normalizeWord)).sort((x, y) => x.word.localeCompare(y.word, 'ru'));
    save('erudit_words_cache', dictWords);
  }
}

function allWords() {
  return dictWords;
}

/* ================== ПРОГРЕСС И ИЗБРАННОЕ ================== */

function loadState() {
  progress = load(profileKey('progress_v2'), {});
  favorites = new Set(load(profileKey('favorites'), []) || []);
}

function prog(id) {
  return progress[id] || { box: 1, correct: 0, wrong: 0, last_review: null };
}

function saveProgress() {
  save(profileKey('progress_v2'), progress);
  queueSync();
}

function isFavorite(id) { return favorites.has(id); }

function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  save(profileKey('favorites'), [...favorites]);
  queueSync();
}

function daysSince(v) {
  if (!v) return Infinity;
  const t = new Date(v).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

function isDue(w) {
  const p = prog(w.id);
  return daysSince(p.last_review) >= INTERVALS[Math.min(4, (p.box || 1) - 1)];
}

function dueWords() {
  return allWords().filter(isDue);
}

function answer(id, correct) {
  const p = prog(id);
  if (correct) { p.correct++; p.box = Math.min(5, p.box + 1); }
  else { p.wrong++; p.box = 1; }
  p.last_review = new Date().toISOString();
  progress[id] = p;
  saveProgress();
}

/* Слово с ударением: «нонконформи́ст». Для «ё» метка не нужна. */
function stressed(w) {
  const word = w.word || '';
  if (typeof w.stress !== 'number') return esc(word);
  const i = Math.min(w.stress, word.length - 1);
  if (word[i] === 'ё' || word[i] === 'Ё') return esc(word);
  return esc(word.slice(0, i + 1)) + '\u0301' + esc(word.slice(i + 1));
}

/* ================== НАБОР СЛОВ (ВСЁ / ИЗБРАННОЕ / КАТЕГОРИИ) ================== */

function scopeWords() {
  let pool = allWords();
  if (studyScope === 'fav') pool = pool.filter((w) => favorites.has(w.id));
  else if (studyScope === 'cats') pool = pool.filter((w) => selectedCats.has(w.category));
  return pool;
}

function setScope(scope) {
  studyScope = scope;
  renderStudy();
}

function toggleScopeCat(cat) {
  if (selectedCats.has(cat)) selectedCats.delete(cat);
  else selectedCats.add(cat);
  save('erudit_scope_cats', [...selectedCats]);
  renderStudy();
}

/* ================== РЕНДЕР ================== */

function renderAll() {
  renderStudy();
  renderChips();
  renderWords();
  renderStats();
}

function renderStudy() {
  const total = allWords().length;
  const pool = scopeWords();
  const due = pool.filter(isDue).length;
  $('#status').textContent = total ? `✓ ${total} слов` : '…';

  const scopeLabel = studyScope === 'fav' ? `Избранное: ${pool.length}` :
    studyScope === 'cats' ? `Категории: ${pool.length}` : `Все слова: ${pool.length}`;

  $('#due-info').innerHTML = total === 0
    ? 'Словарь пуст. Добавь слова во вкладке «Слова».'
    : `${scopeLabel} (${favorites.size} избр.)<br>Пора повторить: <b>${due}</b>`;

  $$('.scope-row .chip').forEach((c) => c.classList.toggle('active', c.dataset.scope === studyScope));
  $('#scope-cats').hidden = studyScope !== 'cats';

  const cats = [...new Set(allWords().map((w) => w.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  if (studyScope === 'cats') {
    $('#scope-cats').innerHTML = cats.map((c) =>
      `<button class="chip ${selectedCats.has(c) ? 'active' : ''}" data-scopecat="${esc(c)}">${esc(c)} (${allWords().filter((w) => w.category === c).length})</button>`
    ).join('') || '<span class="muted">В словаре пока нет категорий — задай их при добавлении слов</span>';
  }

  // кнопка старта блокируется, если набор пуст
  $('#btn-start').disabled = pool.length === 0;
  $('#btn-start').style.opacity = pool.length === 0 ? '.5' : '1';
}

function renderWords() {
  const q = $('#search').value.trim().toLowerCase();
  const list = allWords().filter((w) =>
    (activeCategory === '' ||
      (activeCategory === '__fav__' ? favorites.has(w.id) : (w.category || '') === activeCategory)) &&
    (!q || (w.word + ' ' + w.meaning + ' ' + (w.category || '')).toLowerCase().includes(q))
  );
  $('#word-list').classList.toggle('grid', viewMode === 'grid');

  if (viewMode === 'grid') {
    $('#word-list').innerHTML = list.map((w) => {
      const p = prog(w.id);
      return `
      <div class="gcard" data-id="${esc(w.id)}">
        <div class="gw">${isFavorite(w.id) ? '⭐ ' : ''}${stressed(w)}</div>
        <div class="gm">${esc(w.meaning)}</div>
        <div class="gb">📦 ${p.box || 1}${w.category ? ' · ' + esc(w.category) : ''}</div>
      </div>`;
    }).join('') || '<p class="empty">Ничего не найдено</p>';
    return;
  }

  $('#word-list').innerHTML = list.map((w) => {
    const p = prog(w.id);
    return `
    <div class="wordrow" data-id="${esc(w.id)}">
      <div class="w-main">
        <b>${stressed(w)}</b>
        <span>${esc(w.meaning)}</span>
        ${w.category ? `<em>📁 ${esc(w.category)}</em>` : ''}
      </div>
      <div class="w-meta">📦 ${p.box || 1}<br>✓${p.correct || 0} ✗${p.wrong || 0}</div>
      <div class="w-actions">
        <button class="icon-mini ${isFavorite(w.id) ? 'fav-on' : ''}" data-act="fav" title="Избранное">${isFavorite(w.id) ? '★' : '☆'}</button>
        <button class="icon-mini" data-act="edit" title="Редактировать">✎</button>
        <button class="icon-mini" data-act="del" title="Удалить">🗑</button>
      </div>
    </div>`;
  }).join('') || '<p class="empty">Ничего не найдено</p>';
}

function renderChips() {
  const cats = [...new Set(allWords().map((w) => w.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const counts = {};
  allWords().forEach((w) => { if (w.category) counts[w.category] = (counts[w.category] || 0) + 1; });
  $('#cat-chips').innerHTML = `
    <button class="chip ${activeCategory === '' ? 'active' : ''}" data-cat="">Все (${allWords().length})</button>
    <button class="chip ${activeCategory === '__fav__' ? 'active' : ''}" data-cat="__fav__">⭐ Избранные (${favorites.size})</button>
    ${cats.map((c) => `<button class="chip ${activeCategory === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)} (${counts[c]})</button>`).join('')}`;
}

/* Полная карточка слова */
function nextRepeatText(p) {
  if (!p.last_review) return 'ещё не изучалось';
  const remaining = INTERVALS[Math.min(4, (p.box || 1) - 1)] - daysSince(p.last_review);
  return remaining <= 0 ? 'сегодня' : 'через ' + Math.ceil(remaining) + ' дн.';
}

function openWordCard(id) {
  const w = allWords().find((x) => x.id === id);
  if (!w) return;
  wordCardId = id;
  const p = prog(w.id);
  $('#word-full').innerHTML = `
    <div class="wf-word">${stressed(w)}</div>
    ${w.category ? `<div class="wf-cat">📁 ${esc(w.category)}</div>` : ''}
    <div class="wf-meaning">${esc(w.meaning)}</div>
    ${w.etymology ? `<div class="etym">📖 <b>Происхождение.</b> ${esc(w.etymology)}</div>` : ''}
    ${examplesHtml(w)}
    <div class="wf-progress">
      <span>📦 коробка ${p.box || 1}</span>
      <span>✓ ${p.correct || 0}</span>
      <span>✗ ${p.wrong || 0}</span>
      <span>🔁 ${nextRepeatText(p)}</span>
    </div>
    <div class="wf-actions">
      <button class="ghost ${isFavorite(w.id) ? 'fav-btn-on' : ''}" data-act="fav">${isFavorite(w.id) ? '★ В избранном' : '☆ В избранное'}</button>
      <button class="ghost" data-act="edit">✎ Редактировать</button>
      <button class="ghost danger-outline" data-act="del">🗑</button>
    </div>
    <button id="wf-close" class="primary">Закрыть</button>
  `;
  $('#word-modal').hidden = false;
}

function closeWordCard() { $('#word-modal').hidden = true; }

function renderStats() {
  const all = allWords();
  const box = (w) => prog(w.id).box || 1;
  const learned = all.filter((w) => box(w) >= 4).length;
  const learning = all.filter((w) => box(w) === 2 || box(w) === 3).length;
  const due = dueWords().length;
  $('#stat-total').textContent = all.length;
  $('#stat-learned').textContent = learned;
  $('#stat-learning').textContent = learning;
  $('#stat-due').textContent = due;

  const labels = [
    ['1', 'Каждый день', 'новые и проблемные слова'],
    ['2', 'Раз в день', 'слово начало закрепляться'],
    ['3', 'Раз в 3 дня', 'уже почти помнишь'],
    ['4', 'Раз в неделю', 'уверенно помнишь'],
    ['5', 'Раз в 2 недели', 'слово освоено ✅']
  ];
  $('#boxes').innerHTML = labels.map(([n, title, desc]) => {
    const c = all.filter((w) => box(w) === Number(n)).length;
    const share = all.length ? Math.round(c / all.length * 100) : 0;
    return `
    <div class="boxrow">
      <span class="boxbadge b${n}">${n}</span>
      <div class="boxinfo">
        <b>${title}</b>
        <span>${desc}</span>
        <div class="boxbar"><i style="width:${share}%"></i></div>
      </div>
      <div class="boxcount">${c}</div>
    </div>`;
  }).join('');

  const worst = [...all].sort((a, b) => (prog(b.id).wrong || 0) - (prog(a.id).wrong || 0))
    .filter((w) => (prog(w.id).wrong || 0) > 0).slice(0, 5);
  $('#worst').innerHTML = worst.map((w) => `
    <div class="wordrow">
      <div class="w-main"><b>${stressed(w)}</b><span>${esc(w.meaning)}</span></div>
      <div class="w-meta">ошибок: ${prog(w.id).wrong}</div>
    </div>
  `).join('') || '<p class="muted">Пока нет данных — начни учиться!</p>';
}

/* ================== ВКЛАДКИ ================== */

function switchTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['study', 'words', 'stats'].forEach((t) => {
    $('#tab-' + t).hidden = t !== name;
  });
  if (name === 'stats') renderStats();
  if (name === 'words') { renderChips(); renderWords(); }
  window.scrollTo(0, 0);
}

/* ================== ЗАНЯТИЕ: 4 РЕЖИМА ================== */

function startSession() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const pool = scopeWords();
  if (pool.length === 0) { alert('Выбранный набор пуст — добавь слова или выбери другие категории.'); return; }

  let list = shuffle(pool.filter(isDue)).slice(0, SESSION_SIZE);
  if (list.length === 0) {
    if (!confirm('В выбранном наборе всё повторено. Пройти всё равно?')) return;
    list = shuffle(pool).slice(0, SESSION_SIZE);
  }

  session = { mode, list: [...list], i: 0, right: 0, flipped: false, locked: false };
  $('#study-idle').hidden = true;
  $('#study-session').hidden = false;
  $('#result').textContent = '';
  nextItem();
}

/** Общее завершение ответа: засчитать и перейти дальше. */
function submitAnswer(ok, delayMs) {
  if (!session || session.locked) return;
  session.locked = true;
  setTimeout(() => {
    if (!session) return;
    answer(session.list[session.i].id, ok);
    if (ok) session.right++;
    if (session.i >= session.list.length - 1) finishSession();
    else { session.locked = false; session.i++; nextItem(); }
  }, delayMs || 0);
}

/** Варианты-слова для теста «определение → слово»: сначала той же категории. */
function wordOptions(w) {
  const same = shuffle(allWords().filter((x) => x.id !== w.id && x.category && x.category === w.category)).slice(0, 3);
  const need = 3 - same.length;
  const others = need > 0
    ? shuffle(allWords().filter((x) => x.id !== w.id && x.category !== w.category)).slice(0, need)
    : [];
  return [...same, ...others];
}

function normalizeAnswer(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[\s\-]+/g, '').replace(/\u0301/g, '');
}

function nextItem() {
  const w = session.list[session.i];
  $('#progress').textContent = `Слово ${session.i + 1} из ${session.list.length}`;
  $('#btn-no').hidden = true;
  $('#btn-know').hidden = true;
  $('#answers').innerHTML = '';
  hideNextBtn();
  $('#card').classList.remove('flipped');
  session.flipped = false;
  session.locked = false;

  if (session.mode === 'cards') {
    $('#card').innerHTML = `
      <div class="word">${stressed(w)}</div>
      ${w.category ? `<div class="cat">📁 ${esc(w.category)}</div>` : ''}
      <div class="hint">нажми на карточку, чтобы проверить себя</div>`;
    return;
  }

  if (session.mode === 'quiz') {
    // слово → выбери значение
    $('#card').innerHTML = `
      <div class="word">${stressed(w)}</div>
      <div class="hint">выбери правильное значение</div>`;
    const seen = new Set([w.meaning]);
    const others = shuffle(allWords().filter((x) => !seen.has(x.meaning) && seen.add(x.meaning))).slice(0, 3);
    const opts = shuffle([w, ...others]);
    $('#answers').innerHTML = opts.map((x) =>
      `<button class="opt" data-wid="${esc(x.id)}">${esc(x.meaning)}</button>`
    ).join('');
    $$('#answers .opt').forEach((btn) => {
      btn.addEventListener('click', () => onChoiceAnswer(btn, w));
    });
    return;
  }

  if (session.mode === 'def') {
    // значение → выбери слово (варианты из той же категории)
    $('#card').innerHTML = `
      <div class="meaning-prompt">${esc(w.meaning)}</div>
      ${w.category ? `<div class="cat">📁 ${esc(w.category)}</div>` : ''}
      <div class="hint">каким словом это называется?</div>`;
    const opts = shuffle([w, ...wordOptions(w)]);
    $('#answers').innerHTML = opts.map((x) =>
      `<button class="opt" data-wid="${esc(x.id)}">${stressed(x)}</button>`
    ).join('');
    $$('#answers .opt').forEach((btn) => {
      btn.addEventListener('click', () => onChoiceAnswer(btn, w));
    });
    return;
  }

  if (session.mode === 'type') {
    // значение → напиши слово сам
    $('#card').innerHTML = `
      <div class="meaning-prompt">${esc(w.meaning)}</div>
      ${w.category ? `<div class="cat">📁 ${esc(w.category)}</div>` : ''}
      <div class="hint">напиши слово</div>`;
    $('#answers').innerHTML = `
      <form id="type-form" class="type-form">
        <input id="type-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="слово…">
        <button class="primary" type="submit">Проверить</button>
      </form>
      <div id="type-result"></div>`;
    $('#type-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!session || session.locked) return;
      const val = $('#type-input').value;
      if (!val.trim()) return;
      const ok = normalizeAnswer(val) === normalizeAnswer(w.word);
      session.locked = true;
      $('#type-input').disabled = true;
      $('#type-result').innerHTML = ok
        ? `<div class="type-ok">✓ Верно! <b>${stressed(w)}</b></div>`
        : `<div class="type-bad">✗ Правильно: <b>${stressed(w)}</b></div>`;
      session.pendingOk = ok;
      showNextBtn(ok);
    });
    setTimeout(() => { const el = $('#type-input'); if (el) el.focus(); }, 60);
  }
}

/** Кнопка перехода к следующему варианту (после ответа). */
function showNextBtn(ok) {
  const box = $('#answer-next');
  if (!session) return;
  const last = session.i >= session.list.length - 1;
  $('#btn-next').textContent = last ? '🏁 Завершить занятие' : 'Следующее слово →';
  box.hidden = false;
}

function hideNextBtn() {
  $('#answer-next').hidden = true;
}

/**
 * Общий обработчик вариантов (тесты «слово→значение» и «значение→слово»).
 * До ответа — выбор; после ответа — любой вариант можно раскрыть и
 * посмотреть, что за слово/значение там скрывалось.
 */
function onChoiceAnswer(btn, w) {
  if (!session) return;

  // фаза 2: после ответа — раскрываем подробности варианта по клику
  if (session.locked) {
    toggleOptionDetail(btn, w);
    return;
  }

  // фаза 1: ответ
  session.locked = true;
  const ok = btn.dataset.wid === w.id;
  session.pendingOk = ok;
  $$('#answers .opt').forEach((b) => {
    if (b.dataset.wid === w.id) b.classList.add('right'); // правильный — сразу зелёным
  });
  if (!ok) btn.classList.add('wrong');
  showNextBtn(ok);
}

/** Показать/скрыть, что скрывалось за вариантом. */
function toggleOptionDetail(btn, w) {
  const existing = btn.querySelector('.opt-detail');
  if (existing) { existing.remove(); return; }
  const other = allWords().find((x) => x.id === btn.dataset.wid);
  if (!other) return;
  const span = document.createElement('span');
  span.className = 'opt-detail';
  // в тесте «слово → перевод» вариант-значение раскрываем словом, и наоборот
  span.innerHTML = session.mode === 'def'
    ? '💬 ' + esc(other.meaning)
    : '➡ ' + stressed(other) + (other.category ? ` <em>${esc(other.category)}</em>` : '');
  btn.appendChild(span);
}

function flipCard() {
  if (!session || session.mode !== 'cards' || session.flipped) return;
  session.flipped = true;
  const w = session.list[session.i];
  $('#card').classList.add('flipped');
  // слово остаётся видимым — его же мы и изучаем
  $('#card').innerHTML = `
    <div class="word word-answer">${stressed(w)}</div>
    <div class="translation">${esc(w.meaning)}</div>
    ${w.etymology ? `<div class="etym">📖 ${esc(w.etymology)}</div>` : ''}
    ${examplesHtml(w)}
    <div class="hint">ты помнил значение?</div>`;
  $('#btn-no').hidden = false;
  $('#btn-know').hidden = false;
}

function finishSession() {
  $('#study-session').hidden = true;
  $('#study-idle').hidden = false;
  $('#result').textContent = `🎉 Готово! Правильных ответов: ${session.right} из ${session.list.length}`;
  session = null;
  hideNextBtn();
  renderAll();
}

function exitSession() {
  if (!confirm('Выйти и не закончить занятие?')) return;
  session = null;
  hideNextBtn();
  $('#study-session').hidden = true;
  $('#study-idle').hidden = false;
  renderStudy();
}

/* ================== СЛОВА: ДОБАВЛЕНИЕ / ПРАВКА / УДАЛЕНИЕ ================== */

async function onAddWord(e) {
  e.preventDefault();
  const word = $('#f-word').value.trim();
  const meaning = $('#f-tr').value.trim();
  if (!word || !meaning) return;

  const dup = dictWords.find((w) => w.word.toLowerCase() === word.toLowerCase());
  if (dup && !confirm('Слово «' + dup.word + '» уже есть в словаре. Добавить всё равно?')) return;

  const newWord = normalizeWord({
    id: 'c' + Date.now(),
    word,
    meaning,
    category: $('#f-cat').value.trim(),
    examples: [$('#f-ex').value.trim()].filter(Boolean)
  });

  $('#add-form button[type="submit"]').disabled = true;
  let savedToCloud = false;
  if (cloudEnabled) {
    try { await cloudUpsertWord(newWord); savedToCloud = true; }
    catch (err) { console.warn('Слово не сохранилось в облако', err); }
  }
  if (!dictWords.some((w) => w.id === newWord.id)) {
    dictWords.push(newWord);
    dictWords.sort((a, b) => a.word.localeCompare(b.word, 'ru'));
    save('erudit_words_cache', dictWords);
  }
  $('#f-word').value = ''; $('#f-tr').value = ''; $('#f-cat').value = ''; $('#f-ex').value = '';
  $('#add-form button[type="submit"]').disabled = false;
  renderAll();
  if (cloudEnabled && !savedToCloud) alert('Слово сохранено на устройстве, но облако недоступно — попробуй синхронизировать позже.');
}

async function onWordListClick(e) {
  const row = e.target.closest('.wordrow, .gcard');
  if (!row) return;
  const id = row.dataset.id;
  const actBtn = e.target.closest('button[data-act]');

  if (actBtn && actBtn.dataset.act === 'fav') {
    toggleFavorite(id);
    renderAll();
    return;
  }
  if (actBtn && actBtn.dataset.act === 'edit') {
    await editWord(id);
    return;
  }
  if (actBtn && actBtn.dataset.act === 'del') {
    await deleteWord(id);
    return;
  }

  openWordCard(id);
}

async function editWord(id) {
  const w = dictWords.find((x) => x.id === id);
  if (!w) return;
  const nw = prompt('Слово:', w.word);
  if (nw === null) return;
  const nm = prompt('Значение:', w.meaning);
  if (nm === null) return;
  const nc = prompt('Категория:', w.category || '') ?? w.category;
  w.word = nw.trim() || w.word;
  w.meaning = nm.trim() || w.meaning;
  w.category = String(nc).trim();
  if (cloudEnabled) {
    try { await cloudUpsertWord(w); } catch (err) { alert('Не сохранилось в облако: ' + err.message); }
  }
  save('erudit_words_cache', dictWords);
  renderAll();
}

async function deleteWord(id) {
  const w = dictWords.find((x) => x.id === id);
  if (!w) return;
  if (!confirm(`Удалить «${w.word}» из словаря? Прогресс по нему тоже удалится.`)) return;
  dictWords = dictWords.filter((x) => x.id !== id);
  delete progress[id];
  favorites.delete(id);
  save(profileKey('favorites'), [...favorites]);
  save('erudit_words_cache', dictWords);
  saveProgress();
  if (cloudEnabled) {
    try { await cloudDeleteWord(id); } catch (err) { alert('Не удалилось из облака: ' + err.message); }
  }
  renderAll();
}

/* ================== ЭКСПОРТ / ИМПОРТ / СБРОС ================== */

function exportData() {
  const data = JSON.stringify({
    app: 'erudit', version: 4, profile, progress, favorites: [...favorites], words: dictWords
  }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'erudit-' + profile.toLowerCase() + '-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      let restored = 0;
      if (data.progress) {
        progress = mergeProgress(data.progress, progress);
        saveProgress();
        restored++;
      }
      if (Array.isArray(data.favorites)) {
        favorites = new Set([...favorites, ...data.favorites]);
        save(profileKey('favorites'), [...favorites]);
        queueSync();
      }
      if (Array.isArray(data.words) && cloudEnabled) {
        for (const w of data.words) {
          if (!w || !w.word || !w.meaning) continue;
          const exists = dictWords.some((x) => x.id === (w.id || 'w:' + w.word.toLowerCase()));
          if (!exists) {
            try { await cloudUpsertWord(normalizeWord(w)); dictWords.push(normalizeWord(w)); restored++; } catch (err) {}
          }
        }
        dictWords.sort((a, b) => a.word.localeCompare(b.word, 'ru'));
        save('erudit_words_cache', dictWords);
      }
      renderAll();
      alert('Данные загружены ✓' + (restored ? ' (обновлено записей: ' + restored + ')' : ''));
    } catch (e) {
      alert('Не удалось прочитать файл: ' + e.message);
    }
  };
  reader.readAsText(file);
}

function onResetProgress() {
  if (!confirm(`Точно сбросить весь прогресс «${profile}»? Сами слова останутся.`)) return;
  progress = {};
  saveProgress();
  renderAll();
}

/* ================== МОДАЛКА ================== */

function openModal(msg) {
  $('#modal').hidden = false;
  $('#modal-msg').textContent = msg ||
    (cloudEnabled
      ? `Ты вошёл как «${profile}». Прогресс, избранное и словарь синхронизируются с облаком — на другом устройстве войди тем же ником и ПИНом.`
      : `Ты вошёл как «${profile}». Прогресс хранится в этом браузере. Сделай резервную копию, чтобы не потерять его.`);
}

function closeModal() { $('#modal').hidden = true; }

/* ================== СТАРТ ================== */

function bindUI() {
  $('#login-btn').addEventListener('click', async () => {
    const name = $('#login-name').value.trim();
    const pin = $('#login-pin').value.trim();
    if (!name) { $('#login-name').focus(); return; }
    if (cloudEnabled && (pin.length < 4)) { $('#login-hint').textContent = 'ПИН-код — минимум 4 символа. Он защищает твой прогресс.'; $('#login-pin').focus(); return; }
    $('#login-btn').disabled = true;
    $('#login-btn').textContent = 'Входим…';
    try {
      await login(name, pin);
    } catch (e) {
      console.error(e);
      $('#login-hint').textContent = e.message === 'cloud_read_failed' || e.message === 'cloud_write_failed'
        ? 'Облако недоступно, проверь интернет и попробуй ещё раз.'
        : e.message;
    } finally {
      $('#login-btn').disabled = false;
      $('#login-btn').textContent = 'Начать учиться';
    }
  });
  $('#login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });
  $('#login-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) switchTab(b.dataset.tab);
  });

  $('#btn-start').addEventListener('click', startSession);
  $('#btn-exit').addEventListener('click', exitSession);
  $('#card').addEventListener('click', flipCard);
  $('#btn-know').addEventListener('click', () => submitAnswer(true, 0));
  $('#btn-no').addEventListener('click', () => submitAnswer(false, 0));
  $('#btn-next').addEventListener('click', () => {
    if (!session || !session.locked) return;
    const ok = !!session.pendingOk;
    hideNextBtn();
    submitAnswer(ok, 0);
  });

  // набор слов: всё / избранное / категории
  $('.scope-row').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) setScope(chip.dataset.scope);
  });
  $('#scope-cats').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) toggleScopeCat(chip.dataset.scopecat);
  });

  $('#add-form').addEventListener('submit', onAddWord);
  $('#search').addEventListener('input', renderWords);
  $('#word-list').addEventListener('click', onWordListClick);
  $('#btn-reset').addEventListener('click', onResetProgress);

  // каталог: список/сетка и фильтры
  function setView(mode) {
    viewMode = mode;
    localStorage.setItem('erudit_view', mode);
    $('#view-list').classList.toggle('active', mode === 'list');
    $('#view-grid').classList.toggle('active', mode === 'grid');
    renderWords();
  }
  $('#view-list').addEventListener('click', () => setView('list'));
  $('#view-grid').addEventListener('click', () => setView('grid'));
  $('#view-list').classList.toggle('active', viewMode === 'list');
  $('#view-grid').classList.toggle('active', viewMode === 'grid');
  $('#cat-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    activeCategory = chip.dataset.cat || '';
    renderChips();
    renderWords();
  });

  // полная карточка слова
  $('#word-modal').addEventListener('click', async (e) => {
    const actBtn = e.target.closest('.wf-actions button[data-act]');
    if (actBtn && wordCardId) {
      const act = actBtn.dataset.act;
      if (act === 'fav') {
        toggleFavorite(wordCardId);
        renderAll();
        openWordCard(wordCardId);
        return;
      }
      closeWordCard();
      if (act === 'edit') await editWord(wordCardId);
      if (act === 'del') await deleteWord(wordCardId);
      return;
    }
    if (e.target === e.currentTarget || e.target.id === 'wf-close') closeWordCard();
  });

  $('#btn-settings').addEventListener('click', () => openModal());
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
  $('#btn-logout').addEventListener('click', () => { closeModal(); logout(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

async function init() {
  bindUI();
  applyTheme(document.documentElement.dataset.theme || localStorage.getItem('erudit_theme') || 'light');
  await loadWords();

  loadSession();
  if (profile) {
    loadState();
    enterApp();
  } else {
    showLogin();
  }
}

init();
