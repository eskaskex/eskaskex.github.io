'use strict';

/* ================== БАЗОВОЕ ================== */

const INTERVALS = [0, 1, 3, 7, 14]; // дней между повторениями для коробок 1..5
const SESSION_SIZE = 10;

let words = [];
let session = null;

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

/* ================== API ================== */

function apiUrl() {
  return (localStorage.getItem('erudit_api_url') || (window.CONFIG && window.CONFIG.API_URL) || '').trim();
}

function setApiUrl(u) {
  localStorage.setItem('erudit_api_url', u.trim());
}

async function api(action, payload = {}) {
  const url = apiUrl();
  if (!url) throw new Error('Не указан адрес API (⚙ Настройки)');
  const res = await fetch(url, {
    method: 'POST',
    // text/plain без кастомных заголовков — чтобы Apps Script пропустил запрос без preflight
    body: JSON.stringify({ action, ...payload })
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('Некорректный ответ сервера: ' + text.slice(0, 100)); }
  if (!data.ok) throw new Error(data.error || 'Ошибка API');
  return data;
}

function setStatus(t, ok) {
  const el = $('#status');
  el.textContent = t;
  el.style.opacity = ok === undefined ? '' : ok ? '1' : '.55';
}

/* ================== ЗАГРУЗКА ДАННЫХ ================== */

async function connect() {
  setStatus('Подключение…');
  try {
    await api('ping');
    setStatus('✓ онлайн', true);
    await reload();
  } catch (err) {
    console.error(err);
    setStatus('✗ нет связи', false);
    openSettings('Не удалось подключиться к базе: ' + err.message);
  }
}

async function reload() {
  const data = await api('getWords');
  words = data.words || [];
  renderAll();
}

/* ================== УМНОЕ ПОВТОРЕНИЕ ================== */

function daysSince(v) {
  if (!v) return Infinity;
  const t = new Date(v).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

function isDue(w) {
  return daysSince(w.last_review) >= INTERVALS[Math.min(4, (w.box || 1) - 1)];
}

function dueWords() {
  return words.filter(isDue);
}

/* ================== РЕНДЕР ================== */

function renderAll() {
  renderStudy();
  renderWords();
  renderStats();
}

function renderStudy() {
  const due = dueWords().length;
  const total = words.length;
  $('#due-info').innerHTML = total === 0
    ? 'В словаре пока нет слов. Перейди во вкладку <b>«Слова»</b> и добавь первое.'
    : `Всего слов: <b>${total}</b><br>Пора повторить: <b>${due}</b>`;
}

function renderWords() {
  const q = $('#search').value.trim().toLowerCase();
  const list = words.filter((w) =>
    !q || (w.word + ' ' + w.translation + ' ' + (w.category || '')).toLowerCase().includes(q)
  );
  $('#word-list').innerHTML = list.map((w) => `
    <div class="wordrow" data-id="${esc(w.id)}">
      <div class="w-main">
        <b>${esc(w.word)}</b>
        <span>${esc(w.translation)}</span>
        ${w.category ? `<em>📁 ${esc(w.category)}</em>` : ''}
      </div>
      <div class="w-meta">📦 ${w.box || 1}<br>✓${w.correct || 0} ✗${w.wrong || 0}</div>
      <div class="w-actions">
        <button class="icon-mini" data-act="edit" title="Редактировать">✎</button>
        <button class="icon-mini" data-act="del" title="Удалить">🗑</button>
      </div>
    </div>
  `).join('') || '<p class="empty">Ничего не найдено</p>';
}

function renderStats() {
  const total = words.length;
  const learned = words.filter((w) => (w.box || 1) >= 4).length;
  const due = dueWords().length;
  $('#stat-total').textContent = total;
  $('#stat-learned').textContent = learned;
  $('#stat-due').textContent = due;

  const counts = [1, 2, 3, 4, 5].map((b) => words.filter((w) => (w.box || 1) === b).length);
  const max = Math.max(1, ...counts);
  $('#boxes').innerHTML = counts.map((c, i) => `
    <div class="boxcol">
      <div class="bnum">${c}</div>
      <div class="bar" style="height:${Math.max(4, Math.round(c / max * 100))}%"></div>
      <div class="blabel">№${i + 1}</div>
    </div>
  `).join('');

  const worst = [...words].sort((a, b) => (b.wrong || 0) - (a.wrong || 0)).filter((w) => (w.wrong || 0) > 0).slice(0, 5);
  $('#worst').innerHTML = worst.map((w) => `
    <div class="wordrow">
      <div class="w-main"><b>${esc(w.word)}</b><span>${esc(w.translation)}</span></div>
      <div class="w-meta">ошибок: ${w.wrong || 0}</div>
    </div>
  `).join('') || '<p class="muted">Пока нет данных — начни учиться!</p>';
}

/* ================== ВКЛАДКИ ================== */

function switchTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['study', 'words', 'stats'].forEach((t) => {
    $('#tab-' + t).hidden = t !== name;
  });
  window.scrollTo(0, 0);
}

/* ================== ЗАНЯТИЕ ================== */

function startSession() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  let list = shuffle(dueWords()).slice(0, SESSION_SIZE);

  if (list.length === 0) {
    if (words.length === 0) {
      alert('Сначала добавь слова во вкладке «Слова».');
      return;
    }
    if (!confirm('На сегодня всё повторено. Пройти слова всё равно?')) return;
    list = shuffle([...words]).slice(0, SESSION_SIZE);
  }

  session = { mode, list: [...list], i: 0, right: 0, flipped: false };
  $('#study-idle').hidden = true;
  $('#study-session').hidden = false;
  $('#result').textContent = '';
  nextItem();
}

function nextItem() {
  const w = session.list[session.i];
  $('#progress').textContent = `Слово ${session.i + 1} из ${session.list.length}`;
  $('#btn-no').hidden = true;
  $('#btn-know').hidden = true;
  $('#answers').innerHTML = '';
  $('#card').classList.remove('flipped');
  session.flipped = false;

  if (session.mode === 'cards') {
    $('#card').innerHTML = `
      <div class="word">${esc(w.word)}</div>
      ${w.example ? `<div class="example">${esc(w.example)}</div>` : ''}
      <div class="hint">нажми на карточку, чтобы проверить себя</div>`;
  } else {
    $('#card').innerHTML = `
      <div class="word">${esc(w.word)}</div>
      <div class="hint">выбери правильный перевод</div>`;
    const others = shuffle(words.filter((x) => x.id !== w.id)).slice(0, 3);
    const opts = shuffle([w, ...others]).map((x) => x.translation);
    $('#answers').innerHTML = opts.map((o) => `<button class="opt">${esc(o)}</button>`).join('');
    $$('#answers .opt').forEach((btn) => {
      btn.addEventListener('click', () => onQuizAnswer(btn, w));
    });
  }
}

function flipCard() {
  if (!session || session.mode !== 'cards' || session.flipped) return;
  session.flipped = true;
  const w = session.list[session.i];
  $('#card').classList.add('flipped');
  $('#card').innerHTML = `
    <div class="translation">${esc(w.translation)}</div>
    <div class="example">${esc(w.word)}${w.example ? ' — ' + esc(w.example) : ''}</div>
    <div class="hint">ты помнил перевод?</div>`;
  $('#btn-no').hidden = false;
  $('#btn-know').hidden = false;
}

function onQuizAnswer(btn, w) {
  if (!session) return;
  const ok = btn.textContent.trim().toLowerCase() === String(w.translation).trim().toLowerCase();
  $$('#answers .opt').forEach((b) => {
    b.disabled = true;
    if (b.textContent.trim().toLowerCase() === String(w.translation).trim().toLowerCase()) {
      b.classList.add('right');
    }
  });
  if (!ok) btn.classList.add('wrong');
  answer(w, ok);
}

async function answer(w, correct) {
  if (correct) session.right++;
  // Не ждём сеть дольше 3 секунд — занятие не должно виснуть
  try {
    await Promise.race([
      api('answer', { id: w.id, correct }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]);
  } catch (e) {
    console.error('Не сохранился ответ:', e);
  }
  session.i++;
  if (session.i >= session.list.length) finishSession();
  else nextItem();
}

function finishSession() {
  $('#study-session').hidden = true;
  $('#study-idle').hidden = false;
  $('#result').textContent = `🎉 Готово! Правильных ответов: ${session.right} из ${session.list.length}`;
  session = null;
  reload().catch(console.error);
}

function exitSession() {
  if (!confirm('Выйти и не закончить занятие?')) return;
  session = null;
  $('#study-session').hidden = true;
  $('#study-idle').hidden = false;
  renderStudy();
}

/* ================== СЛОВА ================== */

async function onAddWord(e) {
  e.preventDefault();
  const word = $('#f-word').value.trim();
  const translation = $('#f-tr').value.trim();
  if (!word || !translation) return;
  $('#add-form button[type="submit"]').disabled = true;
  try {
    await api('addWord', {
      word,
      translation,
      category: $('#f-cat').value.trim(),
      example: $('#f-ex').value.trim()
    });
    $('#f-word').value = ''; $('#f-tr').value = ''; $('#f-cat').value = ''; $('#f-ex').value = '';
    await reload();
  } catch (err) {
    alert('Не удалось добавить слово: ' + err.message);
  } finally {
    $('#add-form button[type="submit"]').disabled = false;
  }
}

async function onWordListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.wordrow');
  const id = row.dataset.id;
  const w = words.find((x) => x.id === id);
  if (!w) return;

  if (btn.dataset.act === 'del') {
    if (!confirm(`Удалить «${w.word}»?`)) return;
    try {
      await api('deleteWord', { id });
      await reload();
    } catch (err) {
      alert('Не удалось удалить: ' + err.message);
    }
  }

  if (btn.dataset.act === 'edit') {
    const nw = prompt('Слово:', w.word);
    if (nw === null) return;
    const ntr = prompt('Перевод:', w.translation);
    if (ntr === null) return;
    const ncat = prompt('Категория:', w.category || '') ?? w.category;
    const nex = prompt('Пример:', w.example || '') ?? w.example;
    try {
      await api('updateWord', { id, word: nw, translation: ntr, category: ncat, example: nex });
      await reload();
    } catch (err) {
      alert('Не удалось сохранить: ' + err.message);
    }
  }
}

async function onResetProgress() {
  if (!confirm('Точно сбросить прогресс всех слов? Сами слова останутся.')) return;
  try {
    await api('resetProgress');
    await reload();
  } catch (err) {
    alert('Ошибка: ' + err.message);
  }
}

/* ================== НАСТРОЙКИ ================== */

function openSettings(msg) {
  $('#modal').hidden = false;
  $('#api-input').value = apiUrl();
  if (msg) $('#modal h2').textContent = '⚙ ' + msg;
  else $('#modal h2').textContent = '⚙ Настройки';
}

function closeSettings() {
  $('#modal').hidden = true;
}

async function saveSettings() {
  const u = $('#api-input').value.trim();
  if (!u) { closeSettings(); return; }
  setApiUrl(u);
  closeSettings();
  await connect();
}

/* ================== СТАРТ ================== */

function bindUI() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) switchTab(b.dataset.tab);
  });

  $('#btn-start').addEventListener('click', startSession);
  $('#btn-exit').addEventListener('click', exitSession);
  $('#card').addEventListener('click', flipCard);
  $('#btn-know').addEventListener('click', () => session && answer(session.list[session.i].w, true));
  $('#btn-no').addEventListener('click', () => session && answer(session.list[session.i].w, false));

  $('#add-form').addEventListener('submit', onAddWord);
  $('#search').addEventListener('input', renderWords);
  $('#word-list').addEventListener('click', onWordListClick);
  $('#btn-reset').addEventListener('click', onResetProgress);

  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#api-save').addEventListener('click', saveSettings);
  $('#api-cancel').addEventListener('click', () => {
    if (apiUrl()) closeSettings();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

async function init() {
  bindUI();
  if (!apiUrl()) {
    renderStudy();
    openSettings('Сначала подключим базу данных');
    return;
  }
  await connect();
}

init();
