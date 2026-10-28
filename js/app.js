'use strict';

/* ================== БАЗОВОЕ ================== */

const INTERVALS = [0, 1, 3, 7, 14]; // дней между повторениями для коробок 1..5
const SESSION_SIZE = 10;
const LS_PROGRESS = 'erudit_progress_v1';
const LS_CUSTOM = 'erudit_custom_v1';

let baseWords = [];   // из data/words.json
let customWords = []; // свои слова (localStorage)
let progress = {};    // id -> {box, correct, wrong, last_review}
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

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch (e) { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

/* ================== СЛОВА И ПРОГРЕСС ================== */

function allWords() {
  return [...baseWords, ...customWords];
}

function loadState() {
  progress = load(LS_PROGRESS, {});
  customWords = (load(LS_CUSTOM, []) || []).filter((w) => w && w.word && w.meaning);
}

function prog(id) {
  return progress[id] || { box: 1, correct: 0, wrong: 0, last_review: null };
}

function saveProgress() { save(LS_PROGRESS, progress); }

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

/* ================== РЕНДЕР ================== */

function renderAll() {
  renderStudy();
  renderWords();
  renderStats();
}

function renderStudy() {
  const due = dueWords().length;
  const total = allWords().length;
  $('#status').textContent = total ? `✓ ${total} слов` : '…';
  $('#due-info').innerHTML = total === 0
    ? 'В словаре пока нет слов.'
    : `В словаре: <b>${total}</b> слов<br>Пора повторить: <b>${due}</b>`;
}

function renderWords() {
  const q = $('#search').value.trim().toLowerCase();
  const list = allWords().filter((w) =>
    !q || (w.word + ' ' + w.meaning + ' ' + (w.category || '')).toLowerCase().includes(q)
  );
  $('#word-list').innerHTML = list.map((w) => {
    const p = prog(w.id);
    const custom = customWords.some((c) => c.id === w.id);
    return `
    <div class="wordrow" data-id="${esc(w.id)}">
      <div class="w-main">
        <b>${esc(w.word)}</b>
        <span>${esc(w.meaning)}</span>
        ${w.example ? `<em>${esc(w.example)}</em>` : ''}
      </div>
      <div class="w-meta">📦 ${p.box || 1}<br>✓${p.correct || 0} ✗${p.wrong || 0}</div>
      <div class="w-actions">
        ${custom ? `<button class="icon-mini" data-act="edit" title="Редактировать">✎</button>` : ''}
        ${custom ? `<button class="icon-mini" data-act="del" title="Удалить">🗑</button>` : ''}
      </div>
    </div>`;
  }).join('') || '<p class="empty">Ничего не найдено</p>';
}

function renderStats() {
  const all = allWords();
  const total = all.length;
  const learned = all.filter((w) => (prog(w.id).box || 1) >= 4).length;
  const due = dueWords().length;
  $('#stat-total').textContent = total;
  $('#stat-learned').textContent = learned;
  $('#stat-due').textContent = due;

  const counts = [1, 2, 3, 4, 5].map((b) => all.filter((w) => (prog(w.id).box || 1) === b).length);
  const max = Math.max(1, ...counts);
  $('#boxes').innerHTML = counts.map((c, i) => `
    <div class="boxcol">
      <div class="bnum">${c}</div>
      <div class="bar" style="height:${Math.max(4, Math.round(c / max * 100))}%"></div>
      <div class="blabel">№${i + 1}</div>
    </div>
  `).join('');

  const worst = [...all].sort((a, b) => (prog(b.id).wrong || 0) - (prog(a.id).wrong || 0))
    .filter((w) => (prog(w.id).wrong || 0) > 0).slice(0, 5);
  $('#worst').innerHTML = worst.map((w) => `
    <div class="wordrow">
      <div class="w-main"><b>${esc(w.word)}</b><span>${esc(w.meaning)}</span></div>
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
  window.scrollTo(0, 0);
}

/* ================== ЗАНЯТИЕ ================== */

function startSession() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  let list = shuffle(dueWords()).slice(0, SESSION_SIZE);

  if (list.length === 0) {
    const all = allWords();
    if (all.length === 0) return;
    if (!confirm('На сегодня всё повторено. Пройти слова всё равно?')) return;
    list = shuffle(all).slice(0, SESSION_SIZE);
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
      <div class="hint">нажми на карточку, чтобы проверить себя</div>`;
  } else {
    $('#card').innerHTML = `
      <div class="word">${esc(w.word)}</div>
      <div class="hint">выбери правильное значение</div>`;
    const seen = new Set([w.meaning]);
    const others = shuffle(allWords().filter((x) => !seen.has(x.meaning) && seen.add(x.meaning))).slice(0, 3);
    const opts = shuffle([w, ...others]).map((x) => x.meaning);
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
    <div class="translation">${esc(w.meaning)}</div>
    ${w.example ? `<div class="example">${esc(w.example)}</div>` : ''}
    <div class="hint">ты помнил значение?</div>`;
  $('#btn-no').hidden = false;
  $('#btn-know').hidden = false;
}

function onQuizAnswer(btn, w) {
  if (!session) return;
  const ok = btn.textContent.trim().toLowerCase() === String(w.meaning).trim().toLowerCase();
  $$('#answers .opt').forEach((b) => {
    b.disabled = true;
    if (b.textContent.trim().toLowerCase() === String(w.meaning).trim().toLowerCase()) {
      b.classList.add('right');
    }
  });
  if (!ok) btn.classList.add('wrong');
  setTimeout(() => answer(w.id, ok), ok ? 600 : 1200);
  session.i++;
  setTimeout(() => {
    if (!session) return;
    if (session.i >= session.list.length) finishSession();
    else nextItem();
  }, ok ? 600 : 1400);
}

function finishSession() {
  $('#study-session').hidden = true;
  $('#study-idle').hidden = false;
  $('#result').textContent = `🎉 Готово! Правильных ответов: ${session.right} из ${session.list.length}`;
  session = null;
  renderAll();
}

function exitSession() {
  if (!confirm('Выйти и не закончить занятие?')) return;
  session = null;
  $('#study-session').hidden = true;
  $('#study-idle').hidden = false;
  renderStudy();
}

/* ================== СВОИ СЛОВА ================== */

async function onAddWord(e) {
  e.preventDefault();
  const word = $('#f-word').value.trim();
  const meaning = $('#f-tr').value.trim();
  if (!word || !meaning) return;
  customWords.push({
    id: 'c' + Date.now(),
    word,
    meaning,
    category: $('#f-cat').value.trim(),
    example: $('#f-ex').value.trim()
  });
  save(LS_CUSTOM, customWords);
  $('#f-word').value = ''; $('#f-tr').value = ''; $('#f-cat').value = ''; $('#f-ex').value = '';
  renderAll();
}

function onWordListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.wordrow');
  const id = row.dataset.id;
  const idx = customWords.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const w = customWords[idx];

  if (btn.dataset.act === 'del') {
    if (!confirm(`Удалить «${w.word}»?`)) return;
    customWords.splice(idx, 1);
    delete progress[id];
    save(LS_CUSTOM, customWords);
    saveProgress();
    renderAll();
  }

  if (btn.dataset.act === 'edit') {
    const nw = prompt('Слово:', w.word);
    if (nw === null) return;
    const nm = prompt('Значение:', w.meaning);
    if (nm === null) return;
    customWords[idx] = { ...w, word: nw.trim() || w.word, meaning: nm.trim() || w.meaning };
    save(LS_CUSTOM, customWords);
    renderAll();
  }
}

/* ================== ЭКСПОРТ / ИМПОРТ / СБРОС ================== */

function exportData() {
  const data = JSON.stringify({ app: 'erudit', version: 1, progress, customWords }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'erudit-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.progress) { progress = { ...progress, ...data.progress }; saveProgress(); }
      if (Array.isArray(data.customWords)) {
        const have = new Set(customWords.map((w) => w.id));
        data.customWords.forEach((w) => { if (w && w.id && w.word && w.meaning && !have.has(w.id)) customWords.push(w); });
        save(LS_CUSTOM, customWords);
      }
      renderAll();
      alert('Данные загружены ✓');
    } catch (e) {
      alert('Не удалось прочитать файл: ' + e.message);
    }
  };
  reader.readAsText(file);
}

function onResetProgress() {
  if (!confirm('Точно сбросить прогресс всех слов? Сами слова останутся.')) return;
  progress = {};
  saveProgress();
  renderAll();
}

/* ================== МОДАЛКА ================== */

function openModal(msg) {
  $('#modal').hidden = false;
  $('#modal-msg').textContent = msg || 'Прогресс хранится в этом браузере. Сделай резервную копию, чтобы не потерять его при очистке данных.';
}

function closeModal() { $('#modal').hidden = true; }

/* ================== СТАРТ ================== */

function bindUI() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) switchTab(b.dataset.tab);
  });

  $('#btn-start').addEventListener('click', startSession);
  $('#btn-exit').addEventListener('click', exitSession);
  $('#card').addEventListener('click', flipCard);
  $('#btn-know').addEventListener('click', () => {
    if (!session) return;
    answer(session.list[session.i].id, true);
    session.i++;
    if (session.i >= session.list.length) finishSession(); else nextItem();
  });
  $('#btn-no').addEventListener('click', () => {
    if (!session) return;
    answer(session.list[session.i].id, false);
    session.i++;
    if (session.i >= session.list.length) finishSession(); else nextItem();
  });

  $('#add-form').addEventListener('submit', onAddWord);
  $('#search').addEventListener('input', renderWords);
  $('#word-list').addEventListener('click', onWordListClick);
  $('#btn-reset').addEventListener('click', onResetProgress);

  $('#btn-settings').addEventListener('click', () => openModal());
  $('#modal-close').addEventListener('click', closeModal);
  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

async function init() {
  bindUI();
  try {
    baseWords = await fetch('data/words.json').then((r) => r.json());
  } catch (e) {
    baseWords = [];
    console.error('Не удалось загрузить базу слов', e);
  }
  // дедупликация по слову
  const seen = new Set();
  baseWords = baseWords.filter((w) => w && w.word && w.meaning && !seen.has(w.word.toLowerCase()) && seen.add(w.word.toLowerCase()));
  baseWords = baseWords.map((w) => ({ ...w, id: 'w:' + w.word.toLowerCase() }));
  loadState();
  renderAll();
}

init();
