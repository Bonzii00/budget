'use strict';

// ============ utilità ============

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const MESI_BREVI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

// centesimi -> "1.234,56 €"
function fmt(cents) {
  const neg = cents < 0;
  const c = Math.abs(Math.round(cents));
  const int = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '−' : ''}${int},${String(c % 100).padStart(2, '0')} €`;
}
// centesimi -> "1234,56" (valore per i campi di input)
const fmtIn = (cents) => (cents / 100).toFixed(2).replace('.', ',');
const fmtPct = (v) => `${String(Math.round(v * 100) / 100).replace('.', ',')}%`;
const fmtDay = (iso) => `${Number(iso.slice(8, 10))} ${MESI_BREVI[Number(iso.slice(5, 7)) - 1]}`;

function nextMonthLabel(id) {
  const [y, m] = id.split('-').map(Number);
  return m === 12 ? `1° ${MESI[0]} ${y + 1}` : `1° ${MESI[m]} ${y}`;
}

// Versione dell'app: va aumentata a ogni pubblicazione (insieme a VERSION in sw.js)
const APP_VERSION = '1.2.1';

// Nessun server: le "chiamate" vanno all'archivio locale del telefono (backend.js)
function api(method, url, body) {
  return Backend.request(method, url, body);
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 3500 : 1800);
}

// ============ tema ============
// Preferenza di questo dispositivo: 'auto' (segue l'iPhone), 'light' o 'dark'

function getTheme() {
  try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  updateStatusBar();
}

// Barra di stato (Android) dello stesso colore della sfumatura in alto: metà sfumatura, metà sfondo
function updateStatusBar() {
  const css = getComputedStyle(document.documentElement);
  const rgb = (name) => {
    const h = css.getPropertyValue(name).trim().replace('#', '');
    return h.length === 6 ? [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) : null;
  };
  const wall = rgb('--wall-1');
  const bg = rgb('--bg');
  if (!wall || !bg) return;
  const color = `#${wall.map((w, i) => Math.round(w * 0.5 + bg[i] * 0.5).toString(16).padStart(2, '0')).join('')}`;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = color;
}

// In automatico segue il chiaro/scuro del telefono anche mentre l'app è aperta
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', updateStatusBar);

function setTheme(theme) {
  try {
    if (theme === 'auto') localStorage.removeItem('theme');
    else localStorage.setItem('theme', theme);
  } catch { /* storage non disponibile: vale solo per questa sessione */ }
  applyTheme(theme);
}

applyTheme(getTheme());

// ============ stato ============

let state = null;
let historyList = null;
let tab = 'mese';
let showFixed = false;
let welcomeShown = false;

async function load() {
  try {
    state = await api('GET', 'api/state');
    // Archivio dati nuovo (azzerato): dimentica nome e colore salvati su questo dispositivo
    // (solo se il dispositivo conosceva già un archivio diverso: chi aggiorna non perde niente)
    const instance = state.settings.instanceId;
    const prevInstance = getPref('instance', '');
    if (instance && prevInstance !== instance) {
      if (prevInstance) {
        try { ['userName', 'accent', 'icons'].forEach((k) => localStorage.removeItem(k)); } catch { /* ignora */ }
      }
      setPref('instance', instance);
      applyPrefs();
    }
    if (tab === 'storico') historyList = await api('GET', 'api/history');
    render();
    if (!welcomeShown && (!getPref('userName', '') || !state.settings.onboarded)) {
      welcomeShown = true;
      showWelcome();
    } else if (state.justClosed?.length) {
      monthClosedSheet(state.justClosed);
    }
  } catch (err) {
    renderOffline(err);
  }
}

function renderOffline(err) {
  view.innerHTML = `
    <div class="state-msg">
      <p><b>Non riesco a leggere i dati</b></p>
      <p>Chiudi e riapri l'app. Se il problema resta, ripristina un backup da Impostazioni.<br><small>${esc(err.message)}</small></p>
      <button class="btn" data-act="reload">Riprova</button>
    </div>`;
}

function render() {
  if (!state) return;
  if (tab === 'mese') renderMese();
  else if (tab === 'storico') renderStorico();
  else renderImpostazioni();
}

const salaryIsEstimate = () => state.month.salarySource !== 'reale';
const estimateTag = () => (state.month.salarySource === 'media' ? '(media)' : '(base)');

function ruleText(c, { withEstimate = true } = {}) {
  if (c.kind === 'eur') return 'Importo fisso';
  if (c.base === 'stipendio') {
    return `${fmtPct(c.value)} dello stipendio${withEstimate && salaryIsEstimate() ? ` ${estimateTag()}` : ''}`;
  }
  return `${fmtPct(c.value)} di ${fmt(state.settings.baseCents)}`;
}

function findCategory(id) {
  return state.month.categories.find((c) => c.id === id);
}

// ============ vista: mese ============

function renderMese() {
  const m = state.month;
  const day = Number(state.today.slice(8, 10));
  const est = salaryIsEstimate();

  const fixedRows = showFixed ? `
    <div class="fixed-inline">
      ${m.fixed.map((f) => `<button data-act="edit-fixed" data-id="${f.id}"><span>${esc(f.name)}</span><span class="num">${fmt(f.amount)} <span class="chev">›</span></span></button>`).join('')}
    </div>` : '';

  view.innerHTML = `
    <header class="page-head">
      ${getPref('userName', '') ? `<p class="hello">Ciao, ${esc(getPref('userName', ''))}</p>` : ''}
      <h1>${esc(m.label)}</h1>
      <p>Giorno ${day} di ${m.days}</p>
    </header>

    ${goalCardHtml()}
    ${plansHtml()}

    <section class="summary">
      <button class="summary-row" data-act="salary">
        <span class="label">Stipendio${est ? '<br><span class="salary-cta">Inserisci stipendio</span>' : ''}</span>
        <span class="value num">${fmt(m.salary)}${est ? `<span class="est">${estimateTag()}</span>` : ''}<span class="chev">›</span></span>
      </button>
      <button class="summary-row" data-act="toggle-fixed">
        <span class="label">Spese fisse</span>
        <span class="value num">−${fmt(m.fixedTotal)}<span class="chev">${showFixed ? '▴' : '▾'}</span></span>
      </button>
      ${fixedRows}
      <div class="summary-row">
        <span class="label">Spese variabili</span>
        <span class="value num">${fmt(m.varSpent)}<span class="est">di ${fmt(m.varBudget)}</span></span>
      </div>
      <div class="summary-row big">
        <span class="label">Avanzo previsto<br><span class="hint">se rispetti i budget rimasti</span></span>
        <span class="value num ${m.avanzoPrevisto < 0 ? 'red' : ''}">${fmt(m.avanzoPrevisto)}${est ? '<span class="est">(stimato)</span>' : ''}</span>
      </div>
    </section>

    <div class="section-title"><span>Spese variabili</span></div>
    <div class="cards">
      ${m.categories.map(cardHtml).join('')}
    </div>
    <button class="new-cat" data-act="new-cat">+ Nuova voce</button>
  `;
}

// ANTEPRIMA: icone a linea stile simboli iOS, scelte in base al nome della voce
const ICONS = {
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.8l2.4 11a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.9-1.5L21 7.5H6.2"/>',
  fuel: '<path d="M4.5 21V5.5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2V21M3 21h13M4.5 10.5h10M14.5 8.5l3 3v6a1.5 1.5 0 0 0 3 0V9.5L17.5 6.5"/>',
  smoke: '<path d="M2.5 15.5h14v3.5h-14zM19.5 15.5V19M17 12c0-1.6 2-1.6 2-3.2S17 7.2 17 5.6M20.5 12c0-1.4 1-1.8 1-3"/>',
  food: '<path d="M7 2.5v7.5a2 2 0 0 0 4 0V2.5M9 12v9.5M17 21.5V2.5c-2.5 1.4-4 4-4 8h4"/>',
  music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  receipt: '<path d="M5.5 2.5h13v19l-2.6-1.8-2.2 1.8-2.2-1.8-2.2 1.8-2.2-1.8-2.6 1.8z"/><path d="M9 7.5h6M9 11h6M9 14.5h3.5"/>',
  gym: '<path d="M6.5 6v12M17.5 6v12M3.5 9v6M20.5 9v6M6.5 12h11"/>',
  gift: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M12 8v13M5.5 12v8.5h13V12M12 8S10.5 4 8.3 4a2 2 0 0 0 0 4M12 8s1.5-4 3.7-4a2 2 0 0 1 0 4"/>',
  plane: '<path d="M10.5 13.5 4 11.5l1.5-1.5 7.5 1 4-4c1-1 2.8-1.6 3.4-1 .6.6 0 2.4-1 3.4l-4 4 1 7.5-1.5 1.5-2-6.5-3.4 3.4.3 2.2-1.2 1.2-1.4-3-3-1.4 1.2-1.2 2.2.3z"/>',
  home: '<path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z"/>',
  car: '<path d="M5 17.5h14M3.5 17.5v-4.2l2-5a2 2 0 0 1 1.9-1.3h9.2a2 2 0 0 1 1.9 1.3l2 5v4.2M3.5 13h17"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
  health: '<path d="M12 20.5s-8-4.6-8-10.4A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 8 2.7c0 5.8-8 10.4-8 10.4z"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10.5h18M16 15h2"/>',
};
function iconFor(name) {
  const n = name.toLowerCase();
  const map = [
    [/super|spesa|cibo|aliment/, 'cart'], [/carbur|benzin/, 'fuel'], [/tabac|sigar/, 'smoke'],
    [/ristor|delivery|pizza|bar|pranz|cena/, 'food'], [/music|spotify|netflix|abbon|stream/, 'music'],
    [/piccol|varie|bollett/, 'receipt'], [/palestr|sport/, 'gym'], [/regal/, 'gift'], [/viagg|vacanz/, 'plane'],
    [/affitt|casa|mutuo/, 'home'], [/auto|moto|telepass|parchegg/, 'car'], [/medic|farmac|salute/, 'health'],
  ];
  const key = map.find(([re]) => re.test(n))?.[1] ?? 'wallet';
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg>`;
}

// ============ ANTEPRIMA: preferenze di questo dispositivo ============

const ACCENTS = [['blu', 'Blu'], ['azzurro', 'Azzurro'], ['verde', 'Verde'], ['viola', 'Viola'], ['rubino', 'Rubino']];

function getPref(key, def) {
  try { return localStorage.getItem(key) ?? def; } catch { return def; }
}
function setPref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* solo per questa sessione */ }
}
function applyPrefs() {
  const root = document.documentElement;
  root.dataset.accent = getPref('accent', 'verde');
  root.dataset.icons = getPref('icons', 'on');
  updateStatusBar();
}
applyPrefs();

function swatchesHtml(current) {
  return `<div class="swatches">${ACCENTS.map(([v, l]) => `
    <button type="button" class="swatch ${current === v ? 'on' : ''}" data-accent="${v}"><i class="sw-${v}"></i>${l}</button>`).join('')}</div>`;
}
function bindSwatches(root, onPick) {
  root.querySelectorAll('.swatch').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
    setPref('accent', b.dataset.accent);
    applyPrefs();
    onPick?.(b.dataset.accent);
  }));
}

// ============ configurazione iniziale (primo avvio) ============

const GOAL_MULT = 2.5;
const GOAL_MONTH_OPTIONS = [6, 9, 12, 18, 24];

// "1.234,56" -> 123456 centesimi (NaN se non valido)
function parseEuro(s) {
  let v = String(s ?? '').trim().replace(/[\s€]/g, '');
  if (!v) return NaN;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(v)) v = v.replace(/\./g, '');
  v = v.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return NaN;
  return Math.round(parseFloat(v) * 100);
}

// Stessa logica del server: quanto risparmiare al mese e come si riscalano le voci
function planPreview(baseC, fixedTotal, initial, months, recalc = true) {
  const target = Math.round(fixedTotal * GOAL_MULT);
  const monthly = Math.ceil(Math.max(0, target - initial) / months);
  const cats = state.categories;
  if (!recalc) {
    // percentuali invariate: mostro i budget attuali sulla base indicata
    const budgets = cats.map((c) => ({
      name: c.name,
      budget: c.kind === 'eur' ? c.value : Math.round((c.value / 100) * baseC),
    }));
    return { target, monthly, variable: baseC - fixedTotal - monthly, budgets, ok: true };
  }
  const eurTotal = cats.filter((c) => c.kind === 'eur').reduce((a, c) => a + c.value, 0);
  const pctSum = cats.filter((c) => c.kind === 'pct').reduce((a, c) => a + c.value, 0);
  const available = baseC - fixedTotal - monthly - eurTotal;
  const factor = pctSum > 0 ? ((available / baseC) * 100) / pctSum : 0;
  const budgets = cats.map((c) => ({
    name: c.name,
    budget: c.kind === 'eur' ? c.value : Math.round((Math.max(0.01, Math.floor(c.value * factor * 100) / 100) / 100) * baseC),
  }));
  return { target, monthly, variable: baseC - fixedTotal - monthly, budgets, ok: available > 0 };
}

function showWelcome() {
  const needsSetup = !state.settings.onboarded;
  const steps = needsSetup ? ['nome', 'stipendio', 'fondo', 'fisse', 'tempo'] : ['nome'];
  const data = {
    name: getPref('userName', ''),
    base: state.settings.baseCents > 0 ? fmtIn(state.settings.baseCents) : '',
    fixed: state.fixed.length
      ? state.fixed.map((f) => ({ name: f.name, amount: fmtIn(f.amount) }))
      : [{ name: '', amount: '' }],
    months: 12,
    initial: '',
    // chi ha già dati sceglie se ricalcolare le percentuali; un utente nuovo le ricalcola sempre
    hasData: state.fixed.length > 0 || state.expenses.length > 0,
    recalc: true,
  };
  let step = 0;

  const el = document.createElement('div');
  el.className = 'welcome';
  el.innerHTML = `
    <form class="welcome-card" novalidate>
      <div class="wz-top">
        <button type="button" class="wz-back" aria-label="Indietro"><svg class="ico-back" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg></button>
        <div class="wz-dots">${steps.length > 1 ? steps.map(() => '<span></span>').join('') : ''}</div>
        <span class="wz-back-spacer"></span>
      </div>
      <div class="wz-body"></div>
      <button class="btn" type="submit"></button>
    </form>`;
  document.body.appendChild(el);
  const form = $('form', el);
  const body = $('.wz-body', el);
  const next = $('button[type="submit"]', el);
  const back = $('.wz-back', el);

  const fixedTotal = () => data.fixed.reduce((a, f) => a + (parseEuro(f.amount) || 0), 0);
  const validFixed = () => data.fixed.filter((f) => f.name.trim() && parseEuro(f.amount) > 0);

  function validate() {
    const s = steps[step];
    let ok = true;
    if (s === 'nome') ok = !!data.name.trim();
    if (s === 'stipendio') ok = parseEuro(data.base) > 0;
    if (s === 'fisse') ok = validFixed().length > 0;
    if (s === 'tempo') {
      const initial = parseEuro(data.initial) || 0;
      ok = planPreview(parseEuro(data.base), fixedTotal(), initial, data.months, !data.hasData || data.recalc).ok;
    }
    next.disabled = !ok;
  }

  function renderTempoSummary() {
    const box = $('.plan-box', body);
    if (!box) return;
    const initial = parseEuro(data.initial) || 0;
    const p = planPreview(parseEuro(data.base), fixedTotal(), initial, data.months, !data.hasData || data.recalc);
    box.classList.toggle('bad', !p.ok);
    box.innerHTML = p.ok ? `
      <div class="plan-row"><span>Obiettivo fondo</span><b class="num">${fmt(p.target)}</b></div>
      <div class="plan-row"><span>Da mettere via ogni mese</span><b class="num accent">${fmt(p.monthly)}</b></div>
      <div class="plan-row"><span>Per le spese variabili restano</span><b class="num">${fmt(p.variable)}</b></div>
      <details class="plan-cats"><summary>${data.hasData && !data.recalc ? 'Budget attuali delle voci' : 'Come divido le spese variabili'}</summary>
        ${p.budgets.map((b) => `<div class="plan-row"><span>${esc(b.name)}</span><span class="num">${fmt(b.budget)}</span></div>`).join('')}
      </details>` : `
      <b>Così è troppo stretto.</b><br>Mettendo via ${fmt(p.monthly)} al mese non resta abbastanza per le spese di tutti i giorni. Prova con più mesi.`;
  }

  function renderStep() {
    const s = steps[step];
    el.querySelectorAll('.wz-dots span').forEach((d, i) => d.classList.toggle('on', i <= step));
    back.style.visibility = step > 0 ? 'visible' : 'hidden';
    const last = step === steps.length - 1;
    next.textContent = last ? (needsSetup ? "Entra nell'app" : 'Inizia') : 'Continua';

    if (s === 'nome') {
      body.innerHTML = `
        <div class="welcome-logo"><svg viewBox="0 0 24 24"><path d="M4 20V11M10 20V5M16 20v-8M21.5 20h-19"/></svg></div>
        <h1>Benvenuto</h1>
        <p class="lead">Tieni sotto controllo le spese del mese, voce per voce.</p>
        <label class="field"><span>Come ti chiami?</span>
          <input class="input" data-k="name" maxlength="30" placeholder="Il tuo nome" autocomplete="given-name" value="${esc(data.name)}"></label>
        <div class="field"><span>Scegli il colore</span>${swatchesHtml(getPref('accent', 'verde'))}</div>`;
      bindSwatches(body);
    }

    if (s === 'stipendio') {
      body.innerHTML = `
        <h1>Quanto guadagni al mese?</h1>
        <p class="lead">Più o meno, netto. Lo uso per calcolare i budget finché non inserisci lo stipendio vero del mese.</p>
        <label class="field"><span>Stipendio medio</span>
          <input class="input amount num" data-k="base" inputmode="decimal" placeholder="0,00" value="${esc(data.base)}"></label>`;
    }

    if (s === 'fondo') {
      body.innerHTML = `
        <h1>Mettiamo da parte qualcosa, ${esc(data.name.trim())}</h1>
        <p class="lead">Gli imprevisti capitano a tutti: la macchina dal meccanico, una bolletta più alta del solito, un mese storto. Avere un <b>fondo emergenza</b> vuol dire affrontarli senza ansia.</p>
        <div class="fund-steps" aria-hidden="true">
          ${[0.5, 1, 1.5, 2, 2.5].map((m, i) => `<div style="--h:${24 + i * 14}px"><i></i><small>${String(m).replace('.', ',')}×</small></div>`).join('')}
        </div>
        <p class="lead">L'obiettivo è semplice: mettere via <b>2,5 volte le tue spese fisse</b>. Così, se succede qualcosa, hai più di due mesi coperti.</p>
        <p class="lead">Al resto penso io: ti dico quanto puoi spendere per ogni voce e quello che avanza va nel fondo. Un passo alla volta, ci arrivi in pochi mesi.</p>`;
    }

    if (s === 'fisse') {
      const total = fixedTotal();
      body.innerHTML = `
        <h1>Le tue spese fisse</h1>
        <p class="lead">Quelle che escono ogni mese, sempre uguali: affitto, rate, bollette, abbonamenti…</p>
        <div class="fixed-edit">
          ${data.fixed.map((f, i) => `
            <div class="fixed-edit-row">
              <input class="input" data-fi="${i}" data-fk="name" maxlength="60" placeholder="${i === 0 ? 'es. Affitto' : 'Nome'}" value="${esc(f.name)}">
              <input class="input num" data-fi="${i}" data-fk="amount" inputmode="decimal" placeholder="0,00" value="${esc(f.amount)}">
              <button type="button" class="fixed-del" data-del="${i}" aria-label="Rimuovi">✕</button>
            </div>`).join('')}
          <button type="button" class="fixed-add">+ Aggiungi spesa fissa</button>
        </div>
        <div class="plan-box">
          <div class="plan-row"><span>Totale spese fisse</span><b class="num" data-total>${fmt(total)}</b></div>
          <div class="plan-row"><span>Obiettivo fondo (2,5×)</span><b class="num accent" data-target>${fmt(Math.round(total * GOAL_MULT))}</b></div>
        </div>`;
      body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
        data.fixed.splice(Number(b.dataset.del), 1);
        renderStep();
      }));
      $('.fixed-add', body).addEventListener('click', () => {
        data.fixed.push({ name: '', amount: '' });
        renderStep();
        body.querySelectorAll('[data-fk="name"]')[data.fixed.length - 1]?.focus();
      });
    }

    if (s === 'tempo') {
      body.innerHTML = `
        <h1>In quanto tempo vuoi arrivarci?</h1>
        <p class="lead">Più tempo ti dai, più resta per le spese di tutti i giorni. Potrai cambiarlo quando vuoi.</p>
        <div class="seg chips" data-months>
          ${GOAL_MONTH_OPTIONS.map((m) => `<button type="button" data-v="${m}" class="${data.months === m ? 'on' : ''}">${m} mesi</button>`).join('')}
        </div>
        <label class="field" style="margin-top:14px"><span>Hai già qualcosa da parte? (facoltativo)</span>
          <input class="input num" data-k="initial" inputmode="decimal" placeholder="0,00" value="${esc(data.initial)}"></label>
        ${data.hasData ? `<label class="check"><input type="checkbox" data-recalc ${data.recalc ? 'checked' : ''}> Ricalcola le percentuali delle mie voci in base al piano</label>` : ''}
        <div class="plan-box"></div>`;
      $('[data-recalc]', body)?.addEventListener('change', (e) => {
        data.recalc = e.target.checked;
        renderTempoSummary();
        validate();
      });
      body.querySelectorAll('[data-months] button').forEach((b) => b.addEventListener('click', () => {
        data.months = Number(b.dataset.v);
        body.querySelectorAll('[data-months] button').forEach((x) => x.classList.toggle('on', x === b));
        renderTempoSummary();
        validate();
      }));
      renderTempoSummary();
    }

    validate();
    el.scrollTop = 0;
  }

  // Aggiorna i dati mentre si scrive
  body.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.k) data[t.dataset.k] = t.value;
    if (t.dataset.fi != null) {
      data.fixed[Number(t.dataset.fi)][t.dataset.fk] = t.value;
      const total = fixedTotal();
      $('[data-total]', body).textContent = fmt(total);
      $('[data-target]', body).textContent = fmt(Math.round(total * GOAL_MULT));
    }
    if (t.dataset.k === 'initial') renderTempoSummary();
    validate();
  });

  back.addEventListener('click', () => {
    if (step > 0) { step -= 1; renderStep(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (next.disabled) return;
    if (step < steps.length - 1) {
      step += 1;
      renderStep();
      return;
    }
    next.disabled = true;
    try {
      if (needsSetup) {
        await api('POST', 'api/setup', {
          base: data.base,
          fixed: validFixed().map((f) => ({ name: f.name.trim(), amount: f.amount })),
          months: data.months,
          initial: data.initial || '0',
          recalc: !data.hasData || data.recalc,
        });
      }
      setPref('userName', data.name.trim());
      el.remove();
      await load();
      if (needsSetup) toast('Tutto pronto, si parte!');
    } catch (err) {
      toast(err.message, true);
      next.disabled = false;
    }
  });

  renderStep();
}

// ============ fondo emergenza: contatore in home ============

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function goalStatus(g) {
  if (state.month.id < g.start) return { mood: 'ok', text: `Il piano parte a <b>${monthName(g.start)}</b>: da lì quello che avanza va nel fondo.` };
  if (g.reached) {
    const next = (state.plans || []).filter((p) => p.after && p.status !== 'completo').map((p) => esc(p.name));
    return { mood: 'done', text: `Ce l'hai fatta: il fondo emergenza è completo! ${next.length ? `Da ora la sua quota va a <b>${next.join(', ')}</b>.` : 'Da ora quello che avanza è tutto tuo.'}` };
  }
  if (!g.etaLabel) return { mood: 'behind', text: 'Questo mese non stai mettendo via niente: resta nei budget e si riparte.' };
  const over = state.month.overList.length > 0;
  let text;
  let mood;
  if (g.monthsAhead > 0) { mood = 'ahead'; text = `Vai alla grande: traguardo a <b>${g.etaLabel}</b>, ${plural(g.monthsAhead, 'mese', 'mesi')} prima del previsto.`; }
  else if (g.monthsAhead === 0) { mood = 'ok'; text = `Sei in linea col piano: traguardo a <b>${g.etaLabel}</b>. Continua così!`; }
  else { mood = 'behind'; text = `Traguardo a <b>${g.etaLabel}</b>, ${plural(-g.monthsAhead, 'mese', 'mesi')} dopo il previsto. Qualche spesa in meno e recuperi.`; }
  if (over) text += ' Occhio agli sforamenti: spostano il traguardo.';
  return { mood, text };
}

function goalCardHtml() {
  const g = state.goal;
  if (!g) return '';
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const pSaved = clamp(g.saved / g.target);
  const pWith = clamp(g.withThis / g.target);
  const next = g.milestones.find((m) => !m.reached);
  const done = g.milestones.filter((m) => m.reached).length;
  const status = goalStatus(g);
  return `
    <button class="goal-card mood-${status.mood}" data-act="goal">
      <div class="goal-head">
        <span class="goal-kicker">Fondo emergenza</span>
        <span class="goal-stage">Tappa ${Math.min(done + 1, g.milestones.length)} di ${g.milestones.length}</span>
      </div>
      <div class="goal-amount num">${fmt(g.saved)} <small>di ${fmt(g.target)}</small></div>
      <div class="goal-track">
        <span class="goal-fill-next" style="width:${(pWith * 100).toFixed(1)}%"></span>
        <span class="goal-fill" style="width:${(pSaved * 100).toFixed(1)}%"></span>
        ${g.milestones.map((m) => `<i class="goal-tick ${m.reached ? 'on' : ''}" style="left:${((m.amount / g.target) * 100).toFixed(1)}%"></i>`).join('')}
      </div>
      <div class="goal-labels">${g.milestones.map((m) => `<span class="${m.reached ? 'on' : ''}" style="left:${((m.amount / g.target) * 100).toFixed(1)}%">${String(m.mult).replace('.', ',')}×</span>`).join('')}</div>
      ${next ? `<div class="goal-next">Prossima tappa: <b>${esc(next.name)}</b>, mancano <b class="num">${fmt(Math.max(0, next.amount - g.saved))}</b>${next.etaLabel ? ` · ${next.etaLabel}` : ''}</div>` : ''}
      <div class="goal-month num">${g.thisMonth >= 0 ? `+${fmt(g.thisMonth)}` : fmt(g.thisMonth)} <span>questo mese${salaryIsEstimate() ? ' (stimato)' : ''}</span></div>
      <p class="goal-msg">${status.text}</p>
    </button>`;
}

function goalSheet() {
  const g = state.goal;
  if (!g) return;
  let months = g.months;
  const options = [...new Set([...GOAL_MONTH_OPTIONS, g.months])].sort((a, b) => a - b);
  openSheet(`
    <h2>Fondo emergenza</h2>
    <p class="sheet-sub">Obiettivo: ${String(g.multiplier).replace('.', ',')} volte le spese fisse, cioè ${fmt(g.target)}</p>
    <div class="detail-stats num">
      <div><small>Da parte</small><b>${fmt(g.saved)}</b></div>
      <div><small>Questo mese</small><b class="${g.thisMonth >= 0 ? 'green' : 'red'}">${g.thisMonth >= 0 ? '+' : ''}${fmt(g.thisMonth)}</b></div>
      <div><small>Mancano</small><b>${fmt(Math.max(0, g.target - g.saved))}</b></div>
    </div>

    <div class="section-title"><span>Le tappe</span></div>
    <div class="list">
      ${g.milestones.map((m, i) => `
        <div class="list-row">
          <span class="ms-dot ${m.reached ? 'on' : ''}">${m.reached ? '✓' : i + 1}</span>
          <div class="grow">
            <div class="title">${esc(m.name)}</div>
            <div class="sub num">${String(m.mult).replace('.', ',')}× le spese fisse · ${fmt(m.amount)}</div>
          </div>
          <span class="sub ${m.reached ? 'green' : ''}" style="text-align:right">${m.reached ? 'Raggiunta' : m.etaLabel ?? '—'}</span>
        </div>`).join('')}
    </div>

    <div class="section-title"><span>Il piano</span></div>
    <form>
      <div class="field"><span>Durata (da ${esc(g.start.split('-').reverse().join('/'))}, fine prevista ${esc(g.planEndLabel)})</span>
        <div class="seg chips" data-months>
          ${options.map((m) => `<button type="button" data-v="${m}" class="${m === months ? 'on' : ''}">${m} mesi</button>`).join('')}
        </div></div>
      <label class="field"><span>Già da parte all'inizio</span>
        <input class="input num" name="initial" inputmode="decimal" value="${fmtIn(g.initial)}"></label>
      <label class="check"><input type="checkbox" name="recalc"> Ricalcola le percentuali delle voci per questo piano</label>
      <p class="preview">Piano: <b>${fmt(g.planMonthly)}</b> al mese · ritmo attuale: <b>${fmt(g.pace)}</b> al mese</p>
      <button class="btn" type="submit">Salva piano</button>
    </form>
    <p class="hint" style="margin-top:12px">"Da parte" è quello che avevi all'inizio più l'avanzo di ogni mese chiuso. Il mese in corso conta come previsto, se rispetti i budget.</p>
  `, (root) => {
    root.querySelectorAll('[data-months] button').forEach((b) => b.addEventListener('click', () => {
      months = Number(b.dataset.v);
      root.querySelectorAll('[data-months] button').forEach((x) => x.classList.toggle('on', x === b));
    }));
    bindForm(root, async (fd) => {
      await api('PUT', 'api/goal', { months, initial: fd.get('initial') || '0', recalc: fd.get('recalc') === 'on' });
      return 'Piano aggiornato';
    });
  });
}

// ============ piani di risparmio (oltre al fondo emergenza) ============

const monthName = (id) => `${MESI[Number(id.slice(5, 7)) - 1]} ${id.slice(0, 4)}`;

function planStatusText(p) {
  if (p.status === 'completo') return 'Obiettivo raggiunto';
  if (p.status === 'in-attesa') return `${fmt(p.monthly)} al mese quando il fondo emergenza è completo`;
  if (p.status === 'da-iniziare') return `${fmt(p.monthly)} al mese da ${monthName(p.startMonth)}`;
  return `${fmt(p.monthly)} al mese · questo mese +${fmt(p.thisMonth)}${salaryIsEstimate() ? ' (stimato)' : ''}`;
}

function plansHtml() {
  const plans = state.plans || [];
  if (!state.goal || plans.length === 0) return '';
  return `
    <div class="section-title"><span>Altri risparmi</span></div>
    <div class="list plans-list">
      ${plans.map((p) => `
        <button class="list-row" data-act="plan" data-id="${p.id}">
          <div class="grow">
            <div class="title">${esc(p.name)}</div>
            <div class="sub">${planStatusText(p)}</div>
            ${p.target ? `<div class="bar" style="margin-top:8px"><span style="width:${Math.max(0, Math.min(100, (p.saved / p.target) * 100)).toFixed(1)}%"></span></div>` : ''}
          </div>
          <div style="text-align:right">
            <div class="amount num">${fmt(p.saved)}</div>
            ${p.target ? `<div class="sub num">di ${fmt(p.target)}</div>` : ''}
          </div>
        </button>`).join('')}
    </div>`;
}

function planSheet(p = null) {
  let after = p ? p.after : false;
  const month = state.month.id;
  openSheet(`
    <h2>${p ? esc(p.name) : 'Nuovo piano di risparmio'}</h2>
    <p class="sheet-sub">${p
      ? `Da parte: <b>${fmt(p.saved)}</b>${p.target ? ` di ${fmt(p.target)}` : ''}`
      : 'Per viaggi, auto, investimenti… Il fondo emergenza ha sempre la precedenza.'}</p>
    ${p && p.saved > 0 ? '<button class="btn secondary" type="button" data-withdraw style="margin-bottom:16px">Usa i soldi</button>' : ''}
    <form>
      <label class="field"><span>Nome</span>
        <input class="input" name="name" maxlength="60" placeholder="es. Viaggi" autocomplete="off" value="${esc(p?.name ?? '')}"></label>
      <label class="field"><span>Quanto mettere da parte al mese (€)</span>
        <input class="input num" name="monthly" inputmode="decimal" placeholder="es. 80,00" autocomplete="off" value="${p ? fmtIn(p.monthly) : ''}"></label>
      <label class="field"><span>Obiettivo (€, facoltativo)</span>
        <input class="input num" name="target" inputmode="decimal" placeholder="es. 960,00" autocomplete="off" value="${p?.target ? fmtIn(p.target) : ''}"></label>
      <div class="field"><span>Quando parte</span>
        <div class="seg" data-seg="after">
          <button type="button" data-v="0">Subito</button>
          <button type="button" data-v="1">Dopo il fondo</button>
        </div></div>
      <p class="hint" data-after-hint style="margin:-4px 2px 14px"></p>
      <button class="btn" type="submit">${p ? 'Salva' : 'Crea piano'}</button>
      ${p ? '<button class="btn danger" type="button" data-del>Elimina piano</button>' : ''}
    </form>
    ${p && p.withdrawals.length ? `
      <div class="section-title"><span>Soldi usati</span></div>
      <div class="list">
        ${p.withdrawals.map((w) => `
          <button class="list-row" type="button" data-w="${w.id}" data-open="${w.date.slice(0, 7) === month ? 1 : 0}">
            <div class="grow">
              <div class="title">${w.note ? esc(w.note) : '<span class="muted">Senza nota</span>'}</div>
              <div class="sub">${fmtDay(w.date)} ${w.date.slice(0, 4)}</div>
            </div>
            <span class="amount num">−${fmt(w.amount)}</span>
          </button>`).join('')}
      </div>` : ''}
  `, (root) => {
    const update = () => {
      root.querySelectorAll('[data-seg="after"] button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === after));
      $('[data-after-hint]', root).textContent = after
        ? 'Finché il fondo emergenza non è completo, questa quota va al fondo. Poi passa a questo piano.'
        : 'Riceve la sua quota ogni mese, subito dopo quella del fondo emergenza.';
    };
    root.querySelectorAll('[data-seg="after"] button').forEach((b) => b.addEventListener('click', () => {
      after = b.dataset.v === '1';
      update();
    }));
    update();
    if (!p) $('input[name="name"]', root).focus();
    bindForm(root, async (fd) => {
      const body = { name: fd.get('name'), monthly: fd.get('monthly'), target: fd.get('target'), after };
      const r = p ? await api('PUT', `api/plans/${p.id}`, body) : await api('POST', 'api/plans', body);
      if (r.warning) return r;
      return p ? 'Piano aggiornato' : 'Piano creato, voci variabili ricalcolate';
    });
    $('[data-withdraw]', root)?.addEventListener('click', () => withdrawSheet(p));
    $('[data-del]', root)?.addEventListener('click', () => confirmAndRun(
      `Eliminare il piano "${p.name}"? Da questo mese non riceve più soldi.`,
      () => api('DELETE', `api/plans/${p.id}`),
      'Piano eliminato, voci variabili ricalcolate',
    ));
    root.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.open !== '1') { toast('Questo prelievo è di un mese già chiuso', true); return; }
      confirmAndRun('Annullare questo prelievo? I soldi tornano nel piano.', () => api('DELETE', `api/withdrawals/${b.dataset.w}`), 'Prelievo annullato');
    }));
  });
}

// Soldi presi da un piano (es. il viaggio)
function withdrawSheet(p) {
  const m = state.month;
  openSheet(`
    <h2>Usa i soldi</h2>
    <p class="sheet-sub">${esc(p.name)}: disponibili ${fmt(p.saved)}</p>
    <form>
      <label class="field"><input class="input amount num" name="amount" inputmode="decimal" required placeholder="0,00" autocomplete="off"></label>
      <label class="field"><span>Nota (facoltativa)</span>
        <input class="input" name="note" maxlength="120" placeholder="es. Volo per Amsterdam" autocomplete="off"></label>
      <label class="field"><span>Data</span>
        <input class="input" type="date" name="date" min="${m.id}-01" max="${m.id}-${String(m.days).padStart(2, '0')}" value="${state.today}"></label>
      <button class="btn" type="submit">Registra</button>
    </form>
  `, (root) => {
    $('input', root).focus();
    bindForm(root, async (fd) => {
      await api('POST', `api/plans/${p.id}/withdraw`, { amount: fd.get('amount'), note: fd.get('note'), date: fd.get('date') });
      return 'Prelievo registrato';
    });
  });
}

function cardHtml(c, i = 0) {
  const ratio = c.budget > 0 ? c.spent / c.budget : (c.spent > 0 ? 2 : 0);
  const barCls = c.over ? 'over' : ratio >= 0.85 ? 'warn' : '';
  const left = c.over
    ? `<span class="red">Sforato di ${fmt(c.spent - c.budget)}</span>`
    : `<span class="${ratio >= 0.85 ? '' : 'green'}">Restano ${fmt(c.remaining)}</span>`;
  return `
    <article class="card ${c.over ? 'over' : ''}">
      <div class="card-top">
        <span class="cat-icon" aria-hidden="true">${iconFor(c.name)}</span>
        <button class="card-main" data-act="detail" data-id="${c.id}">
          <div class="card-name">${esc(c.name)}${c.archived ? '<span class="archived-tag">eliminata</span>' : ''}</div>
          <div class="card-rule">${esc(ruleText(c))}</div>
        </button>
        ${c.archived ? '' : `<button class="add-btn" data-act="add" data-id="${c.id}" aria-label="Aggiungi spesa: ${esc(c.name)}"><svg class="ico-plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>`}
      </div>
      <button class="card-body" data-act="detail" data-id="${c.id}">
        <div class="card-figures">
          <div class="card-spent num">${fmt(c.spent)} <small>/ ${fmt(c.budget)}</small></div>
          <div class="card-left num">${left}</div>
        </div>
        <div class="bar ${barCls}"><span style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></span></div>
      </button>
    </article>`;
}

// ============ vista: storico ============

function renderStorico() {
  const list = historyList || [];
  view.innerHTML = `
    <header class="page-head">
      <h1>Storico</h1>
      <p>Mesi chiusi e report</p>
    </header>
    ${list.length === 0 ? `
      <div class="list"><div class="list-empty">
        Nessun mese chiuso per ora.<br>Il primo report verrà creato il ${nextMonthLabel(state.month.id)}.
      </div></div>` : `
      <div class="list">
        ${list.map((h) => `
          <button class="list-row" data-act="history" data-id="${h.id}">
            <div class="grow">
              <div class="title"><b>${esc(h.label)}</b></div>
              <div class="sub num">Stipendio ${fmt(h.salary)}${h.salarySource !== 'reale' ? ' (stimato)' : ''} · Variabili ${fmt(h.varSpent)}</div>
            </div>
            <div style="text-align:right">
              <div class="amount num ${h.avanzo < 0 ? 'red' : ''}">${fmt(h.avanzo)}</div>
              <div>${h.overCount ? `<span class="badge">${h.overCount} sforat${h.overCount === 1 ? 'a' : 'e'}</span>` : '<span class="badge ok">ok</span>'}</div>
            </div>
          </button>`).join('')}
      </div>
      <p class="hint" style="margin:10px 4px">L'importo a destra è l'avanzo del mese.</p>`}
  `;
}

async function historySheet(id) {
  let s;
  try {
    s = await api('GET', `api/history/${id}`);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  openSheet(`
    <h2>${esc(s.label)}</h2>
    <p class="sheet-sub">Chiuso il ${esc(s.closedOn.split('-').reverse().join('/'))}</p>

    <div class="list">
      <div class="list-row"><div class="grow">Stipendio${s.salarySource !== 'reale' ? ' <span class="red">(non inserito, stimato)</span>' : ''}</div><div class="amount num">${fmt(s.salary)}</div></div>
      <div class="list-row"><div class="grow">Spese fisse</div><div class="amount num">−${fmt(s.fixedTotal)}</div></div>
      <div class="list-row"><div class="grow">Spese variabili</div><div class="amount num">−${fmt(s.varSpent)}</div></div>
      <div class="list-row total"><div class="grow">Avanzo</div><div class="amount num ${s.avanzo < 0 ? 'red' : ''}">${fmt(s.avanzo)}</div></div>
      ${s.savings ? [['Fondo emergenza', s.savings.emergency], ...Object.entries(s.savings.plans || {}).map(([id, a]) => [s.savings.names?.[id] ?? 'Piano', a])]
    .map(([n, a]) => `<div class="list-row"><div class="grow sub">→ ${esc(n)}</div><div class="amount num">${fmt(a)}</div></div>`).join('') : ''}
    </div>

    <table class="report-table num">
      <tr><th>Voce</th><th>Budget</th><th>Speso</th><th>Diff.</th></tr>
      ${s.categories.map((c) => `
        <tr class="${c.over ? 'over' : ''}">
          <td>${esc(c.name)}${c.over ? ' ⚠︎' : ''}</td><td>${fmt(c.budget)}</td><td>${fmt(c.spent)}</td><td>${fmt(c.remaining)}</td>
        </tr>`).join('')}
      <tr class="tot"><td>Totale</td><td>${fmt(s.varBudget)}</td><td>${fmt(s.varSpent)}</td><td>${fmt(s.varBudget - s.varSpent)}</td></tr>
    </table>

    ${s.overList.length ? `<p class="red" style="margin:0 0 16px;font-size:14px"><b>Sforato:</b> ${s.overList.map((o) => `${esc(o.name)} +${fmt(o.over)}`).join(', ')}</p>` : ''}

    <div class="btn-row">
      <button class="btn" type="button" data-report="pdf">Report PDF</button>
      <button class="btn secondary" type="button" data-report="csv">CSV</button>
    </div>
  `, (root) => {
    root.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', () => {
      Report[b.dataset.report](s).catch((err) => toast(err.message, true));
    }));
  });
}

// ============ vista: impostazioni ============

function renderImpostazioni() {
  const { settings, categories, fixed } = state;
  const fixedTotal = fixed.reduce((a, f) => a + f.amount, 0);

  // Allocazione calcolata sulla base di riferimento
  const base = settings.baseCents;
  const varOnBase = categories.reduce((a, c) => a + (c.kind === 'eur' ? c.value : Math.round((c.value / 100) * base)), 0);
  const pctFixed = (fixedTotal / base) * 100;
  const pctVar = (varOnBase / base) * 100;
  const saving = state.goal?.plannedSaving ?? 0;
  const pctSave = (saving / base) * 100;
  const pctTot = pctFixed + pctVar + pctSave;
  const bad = pctTot > 100;

  view.innerHTML = `
    <header class="page-head">
      <h1>Impostazioni</h1>
    </header>

    <div class="section-title"><span>Profilo</span></div>
    <div class="list" style="padding:14px 16px 16px">
      <label class="field" style="margin:0"><span>Il tuo nome</span>
        <input class="input" id="pref-name" maxlength="30" placeholder="Il tuo nome" value="${esc(getPref('userName', ''))}"></label>
    </div>

    <div class="section-title"><span>Risparmio</span></div>
    <div class="list">
      ${state.goal ? `
        <button class="list-row" data-act="goal">
          <div class="grow">
            <div class="title">Fondo emergenza</div>
            <div class="sub">Obiettivo ${fmt(state.goal.target)} · ${state.goal.months} mesi · ${fmt(state.goal.planMonthly)} al mese</div>
          </div>
          <span class="chev">›</span>
        </button>
        ${(state.plans || []).map((p) => `
          <button class="list-row" data-act="plan" data-id="${p.id}">
            <div class="grow">
              <div class="title">${esc(p.name)}</div>
              <div class="sub">${fmt(p.monthly)} al mese${p.target ? ` · obiettivo ${fmt(p.target)}` : ''}${p.after ? ' · dopo il fondo' : ''}</div>
            </div>
            <span class="chev">›</span>
          </button>`).join('')}
        <button class="list-row add" data-act="new-plan">+ Nuovo piano di risparmio</button>` : '<button class="list-row add" data-act="setup">Configura il fondo emergenza</button>'}
    </div>

    <div class="section-title"><span>Aspetto</span></div>
    <div class="list" style="padding:14px 16px 16px">
      <div class="field"><span>Tema</span>
        <div class="seg" data-theme-seg>
          ${[['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([v, l]) => `
            <button type="button" data-v="${v}" class="${getTheme() === v ? 'on' : ''}">${l}</button>`).join('')}
        </div></div>
      <div class="field"><span>Colore</span>${swatchesHtml(getPref('accent', 'verde'))}</div>
      <div class="field" style="margin:0"><span>Icone delle voci</span>
        <div class="seg" data-icons-seg>
          ${[['on', 'Mostra'], ['off', 'Nascondi']].map(([v, l]) => `
            <button type="button" data-v="${v}" class="${getPref('icons', 'on') === v ? 'on' : ''}">${l}</button>`).join('')}
        </div></div>
    </div>

    <div class="section-title"><span>Generali</span></div>
    <form id="settings-form" class="list" style="padding:14px 16px 16px">
      <label class="field"><span>Base di riferimento (stipendio medio)</span>
        <input class="input num" name="base" inputmode="decimal" value="${fmtIn(base)}"></label>
      <label class="field"><span>Mesi da usare per la media dello stipendio</span>
        <input class="input num" name="avgMonths" inputmode="numeric" value="${settings.avgMonths}"></label>
      <button class="btn" type="submit">Salva</button>
    </form>

    <div class="section-title"><span>Voci variabili</span></div>
    <div class="list">
      ${categories.map((c, i) => `
        <div class="list-row">
          <button class="grow" style="text-align:left" data-act="edit-cat" data-id="${c.id}">
            <div class="title">${esc(c.name)}</div>
            <div class="sub">${esc(ruleText(c, { withEstimate: false }))}</div>
          </button>
          ${orderBtns('cat', i, categories.length)}
        </div>`).join('')}
      <button class="list-row add" data-act="new-cat">+ Nuova voce</button>
    </div>

    <div class="section-title"><span>Spese fisse</span></div>
    <div class="list">
      ${fixed.map((f, i) => `
        <div class="list-row">
          <button class="grow" style="text-align:left" data-act="edit-fixed" data-id="${f.id}">
            <div class="title">${esc(f.name)}</div>
          </button>
          <span class="amount num">${fmt(f.amount)}</span>
          ${orderBtns('fixed', i, fixed.length)}
        </div>`).join('')}
      <div class="list-row total"><div class="grow">Totale</div><span class="amount num">${fmt(fixedTotal)}</span></div>
      <button class="list-row add" data-act="new-fixed">+ Aggiungi spesa fissa</button>
    </div>

    <div class="alloc ${bad ? 'bad' : ''}">
      Su una base di <b>${fmt(base)}</b>: fisse <b>${fmtPct(pctFixed)}</b> + variabili <b>${fmtPct(pctVar)}</b>${saving ? ` + risparmio <b>${fmtPct(pctSave)}</b>` : ''} = <b>${fmtPct(pctTot)}</b>.<br>
      ${bad
        ? `Superi il 100% di <b>${fmt(fixedTotal + varOnBase + saving - base)}</b>: riduci qualche voce o una quota di risparmio.`
        : `${saving ? 'Margine in più' : 'Avanzo previsto'}: <b>${fmt(base - fixedTotal - varOnBase - saving)}</b> (${fmtPct(100 - pctTot)})${saving ? ', va al fondo emergenza' : ''}.`}
    </div>

    <div class="section-title"><span>I tuoi dati</span></div>
    <div class="list">
      <button class="list-row" data-act="backup">
        <div class="grow">
          <div class="title">Salva un backup</div>
          <div class="sub">${settings.lastBackup ? `Ultimo: ${new Date(settings.lastBackup).toLocaleDateString('it-IT')}` : 'Mai fatto'}</div>
        </div>
        <span class="chev">›</span>
      </button>
      <button class="list-row" data-act="restore">
        <div class="grow"><div class="title">Ripristina da un backup</div></div>
        <span class="chev">›</span>
      </button>
      <button class="list-row" data-act="reset">
        <div class="grow"><div class="title red">Cancella tutto e ricomincia</div></div>
      </button>
    </div>
    <p class="hint" style="margin:10px 4px">I dati restano solo su questo telefono: nessuno li vede. Salva un backup ogni tanto (ad esempio su iCloud Drive), così se cambi telefono o cancelli l'app non perdi niente.</p>
    <p class="hint" style="margin:4px 4px 10px">Versione ${APP_VERSION}</p>
  `;

  bindSwatches(view);
  view.querySelectorAll('[data-icons-seg] button').forEach((b) => b.addEventListener('click', () => {
    setPref('icons', b.dataset.v);
    applyPrefs();
    view.querySelectorAll('[data-icons-seg] button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#pref-name').addEventListener('change', (e) => {
    const name = e.target.value.trim();
    if (!name) { e.target.value = getPref('userName', ''); return; }
    setPref('userName', name);
    toast('Nome salvato');
  });

  view.querySelectorAll('[data-theme-seg] button').forEach((b) => b.addEventListener('click', () => {
    setTheme(b.dataset.v);
    view.querySelectorAll('[data-theme-seg] button').forEach((x) => x.classList.toggle('on', x === b));
  }));

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('PUT', 'api/settings', { base: fd.get('base'), avgMonths: Number(fd.get('avgMonths')) });
      toast('Impostazioni salvate');
      load();
    } catch (err) { toast(err.message, true); }
  });
}

function orderBtns(kind, i, len) {
  return `<div class="order-btns">
    <button data-act="move" data-kind="${kind}" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Sposta su">▲</button>
    <button data-act="move" data-kind="${kind}" data-i="${i}" data-dir="1" ${i === len - 1 ? 'disabled' : ''} aria-label="Sposta giù">▼</button>
  </div>`;
}

async function move(kind, i, dir) {
  const items = kind === 'cat' ? state.categories : state.fixed;
  const ids = items.map((x) => x.id);
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await api('POST', kind === 'cat' ? 'api/categories/order' : 'api/fixed/order', { ids });
    await load();
  } catch (err) { toast(err.message, true); }
}

// ============ sheet ============

const sheetEl = $('#sheet');
const sheetPanel = $('.sheet', sheetEl);
const sheetBody = $('#sheet-body');
const BACKDROP_ALPHA = 0.35;

function openSheet(html, onMount) {
  sheetBody.innerHTML = html;
  sheetPanel.classList.remove('settling', 'dragging');
  sheetPanel.style.transform = '';
  sheetPanel.scrollTop = 0;
  sheetEl.style.backgroundColor = '';
  sheetEl.hidden = false;
  document.body.style.overflow = 'hidden';
  onMount?.(sheetBody);
}

function closeSheet() {
  sheetEl.hidden = true;
  sheetBody.innerHTML = '';
  sheetPanel.style.transform = '';
  sheetPanel.classList.remove('settling', 'dragging');
  sheetEl.style.backgroundColor = '';
  document.body.style.overflow = '';
}

// Chiusura animata: lo sheet scende e sparisce
function dismissSheet() {
  if (sheetEl.hidden) return;
  document.activeElement?.blur?.();
  sheetPanel.classList.remove('dragging');
  sheetPanel.classList.add('settling');
  sheetPanel.style.transform = 'translateY(100%)';
  sheetEl.style.backgroundColor = 'rgba(0,0,0,0)';
  setTimeout(closeSheet, 230);
}

sheetEl.addEventListener('click', (e) => {
  if (e.target === sheetEl) dismissSheet();
});

// Trascina verso il basso per chiudere: dalla maniglia in alto, oppure dal contenuto se è già in cima
let drag = null;

sheetPanel.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  drag = {
    y0: e.touches[0].clientY,
    t0: performance.now(),
    dy: 0,
    active: false,
    fromHandle: !!e.target.closest('.sheet-handle'),
  };
}, { passive: true });

sheetPanel.addEventListener('touchmove', (e) => {
  if (!drag) return;
  const dy = e.touches[0].clientY - drag.y0;
  if (!drag.active) {
    if (dy > 6 && (drag.fromHandle || sheetPanel.scrollTop <= 0)) {
      drag.active = true;
      drag.y0 = e.touches[0].clientY; // evita lo scatto iniziale
      sheetPanel.classList.remove('settling');
      sheetPanel.classList.add('dragging');
      document.activeElement?.blur?.();
    } else if (Math.abs(dy) > 6) {
      drag = null; // è uno scroll normale del contenuto
      return;
    } else {
      return;
    }
  }
  e.preventDefault();
  drag.dy = Math.max(0, e.touches[0].clientY - drag.y0);
  sheetPanel.style.transform = `translateY(${drag.dy}px)`;
  const progress = Math.min(1, drag.dy / sheetPanel.offsetHeight);
  sheetEl.style.backgroundColor = `rgba(0,0,0,${(BACKDROP_ALPHA * (1 - progress)).toFixed(3)})`;
}, { passive: false });

function endDrag() {
  if (!drag) return;
  const { active, dy, t0 } = drag;
  drag = null;
  if (!active) return;
  const velocity = dy / Math.max(1, performance.now() - t0); // px/ms
  if (dy > Math.min(140, sheetPanel.offsetHeight * 0.3) || (velocity > 0.6 && dy > 30)) {
    dismissSheet();
  } else {
    sheetPanel.classList.remove('dragging');
    sheetPanel.classList.add('settling');
    sheetPanel.style.transform = '';
    sheetEl.style.backgroundColor = '';
  }
}

sheetPanel.addEventListener('touchend', endDrag);
sheetPanel.addEventListener('touchcancel', endDrag);

// Gestione standard dell'invio di un form in uno sheet
function bindForm(root, submit) {
  const form = $('form', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try {
      const msg = await submit(new FormData(form));
      closeSheet();
      if (msg?.warning) toast(msg.warning, true);
      else if (msg) toast(msg);
      await load();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

async function confirmAndRun(question, fn, msg) {
  if (!window.confirm(question)) return;
  try {
    const r = await fn();
    closeSheet();
    if (r?.warning) toast(r.warning, true);
    else toast(msg);
    await load();
  } catch (err) { toast(err.message, true); }
}

// --- stipendio ---

function salarySheet() {
  const m = state.month;
  const est = salaryIsEstimate();
  const explain = m.salarySource === 'media'
    ? `Ora sto usando la media ${m.salaryMonths === 1 ? "dell'ultimo mese" : `degli ultimi ${m.salaryMonths} mesi`}: ${fmt(m.salary)}.`
    : `Ora sto usando la base di riferimento: ${fmt(m.salary)}.`;
  openSheet(`
    <h2>Stipendio di ${esc(m.label)}</h2>
    <p class="sheet-sub">${est ? explain : 'Stipendio inserito. Puoi correggerlo.'}</p>
    <form>
      <label class="field"><input class="input amount num" name="amount" inputmode="decimal" required placeholder="0,00" autocomplete="off" value="${est ? '' : fmtIn(m.salary)}"></label>
      <button class="btn" type="submit">Salva stipendio</button>
      ${est ? '' : '<button class="btn danger" type="button" data-clear>Rimuovi e torna alla stima</button>'}
    </form>
  `, (root) => {
    $('input', root).focus();
    bindForm(root, async (fd) => {
      await api('PUT', 'api/salary', { amount: fd.get('amount') });
      return 'Stipendio salvato';
    });
    $('[data-clear]', root)?.addEventListener('click', () => confirmAndRun(
      'Rimuovere lo stipendio inserito? Verrà usata di nuovo la stima.',
      () => api('PUT', 'api/salary', { amount: null }),
      'Stipendio rimosso',
    ));
  });
}

// --- spesa (nuova o modifica) ---

function expenseSheet(cat, exp = null) {
  const m = state.month;
  const min = `${m.id}-01`;
  const max = `${m.id}-${String(m.days).padStart(2, '0')}`;
  const activeCats = m.categories.filter((c) => !c.archived || c.id === cat.id);
  openSheet(`
    <h2>${exp ? 'Modifica spesa' : esc(cat.name)}</h2>
    <p class="sheet-sub">${cat.over ? `<span class="red">Già sforato di ${fmt(cat.spent - cat.budget)}</span>` : `Restano ${fmt(cat.remaining)} su ${fmt(cat.budget)}`}</p>
    <form>
      <label class="field"><input class="input amount num" name="amount" inputmode="decimal" required placeholder="0,00" autocomplete="off" value="${exp ? fmtIn(exp.amount) : ''}"></label>
      ${exp ? `
        <label class="field"><span>Voce</span>
          <select class="input" name="categoryId">
            ${activeCats.map((c) => `<option value="${c.id}" ${c.id === exp.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select></label>` : ''}
      <label class="field"><span>Nota (facoltativa)</span>
        <input class="input" name="note" maxlength="120" placeholder="es. Esselunga" autocomplete="off" value="${esc(exp?.note ?? '')}"></label>
      <label class="field"><span>Data</span>
        <input class="input" type="date" name="date" min="${min}" max="${max}" value="${exp ? exp.date : state.today}"></label>
      <button class="btn" type="submit">${exp ? 'Salva' : 'Aggiungi spesa'}</button>
      ${exp ? '<button class="btn danger" type="button" data-del>Elimina spesa</button>' : ''}
    </form>
  `, (root) => {
    $('input', root).focus();
    bindForm(root, async (fd) => {
      const body = { categoryId: exp ? Number(fd.get('categoryId')) : cat.id, amount: fd.get('amount'), note: fd.get('note'), date: fd.get('date') };
      if (exp) {
        await api('PUT', `api/expenses/${exp.id}`, body);
        return 'Spesa aggiornata';
      }
      await api('POST', 'api/expenses', body);
      return `Spesa aggiunta a ${cat.name}`;
    });
    $('[data-del]', root)?.addEventListener('click', () => confirmAndRun(
      `Eliminare la spesa di ${fmt(exp.amount)}?`,
      () => api('DELETE', `api/expenses/${exp.id}`),
      'Spesa eliminata',
    ));
  });
}

// --- dettaglio voce ---

function detailSheet(cat) {
  const exps = state.expenses.filter((e) => e.categoryId === cat.id);
  openSheet(`
    <h2>${esc(cat.name)}</h2>
    <p class="sheet-sub">${esc(ruleText(cat))}</p>
    <div class="detail-stats num">
      <div><small>Budget</small><b>${fmt(cat.budget)}</b></div>
      <div><small>Speso</small><b class="${cat.over ? 'red' : ''}">${fmt(cat.spent)}</b></div>
      <div><small>${cat.over ? 'Sforato' : 'Restano'}</small><b class="${cat.over ? 'red' : 'green'}">${fmt(Math.abs(cat.remaining))}</b></div>
    </div>
    ${cat.archived ? '' : '<button class="btn" data-a="add">+ Aggiungi spesa</button>'}
    <div class="section-title"><span>Spese del mese</span><span>${exps.length}</span></div>
    <div class="list">
      ${exps.length === 0 ? '<div class="list-empty">Nessuna spesa registrata</div>' : exps.map((e) => `
        <button class="list-row" data-exp="${e.id}">
          <div class="grow">
            <div class="title">${e.note ? esc(e.note) : '<span class="muted">Senza nota</span>'}</div>
            <div class="sub">${fmtDay(e.date)}</div>
          </div>
          <span class="amount num">${fmt(e.amount)}</span>
        </button>`).join('')}
    </div>
    ${cat.archived ? '' : '<button class="btn secondary" data-a="edit">Modifica voce</button>'}
  `, (root) => {
    $('[data-a="add"]', root)?.addEventListener('click', () => expenseSheet(cat));
    $('[data-a="edit"]', root)?.addEventListener('click', () => categorySheet(state.categories.find((c) => c.id === cat.id)));
    root.querySelectorAll('[data-exp]').forEach((btn) => btn.addEventListener('click', () => {
      expenseSheet(cat, exps.find((e) => e.id === Number(btn.dataset.exp)));
    }));
  });
}

// --- voce variabile (nuova o modifica) ---

// fromFixed: spesa fissa da trasformare in voce variabile
function categorySheet(cat = null, { fromFixed = null } = {}) {
  let kind = fromFixed ? 'eur' : cat?.kind ?? 'pct';
  let base = cat?.base ?? 'riferimento';
  let initialValue = '';
  if (fromFixed) initialValue = fmtIn(fromFixed.amount);
  else if (cat) initialValue = cat.kind === 'pct' ? String(cat.value).replace('.', ',') : fmtIn(cat.value);
  const name = fromFixed?.name ?? cat?.name ?? '';
  const m = state.month;

  let title = 'Nuova voce';
  let sub = 'Spesa variabile da tracciare';
  let submitLabel = 'Crea voce';
  if (cat) { title = 'Modifica voce'; submitLabel = 'Salva'; }
  if (fromFixed) {
    title = 'Sposta nelle variabili';
    sub = `"${esc(fromFixed.name)}" non sarà più una spesa fissa: diventa una voce con il suo budget e il tasto +`;
    submitLabel = 'Sposta nelle variabili';
  }

  openSheet(`
    <h2>${title}</h2>
    <p class="sheet-sub">${sub}</p>
    <form>
      <label class="field"><span>Nome</span>
        <input class="input" name="name" maxlength="60" placeholder="es. Palestra" autocomplete="off" value="${esc(name)}"></label>
      <div class="field"><span>Come calcolo il budget</span>
        <div class="seg" data-seg="kind">
          <button type="button" data-v="pct">Percentuale</button>
          <button type="button" data-v="eur">Importo fisso</button>
        </div></div>
      <label class="field"><span data-value-label></span>
        <input class="input num" name="value" inputmode="decimal" autocomplete="off" value="${initialValue}"></label>
      <div class="field" data-base-field><span>Percentuale calcolata su</span>
        <div class="seg" data-seg="base">
          <button type="button" data-v="stipendio">Stipendio del mese</button>
          <button type="button" data-v="riferimento">Base ${fmt(state.settings.baseCents).replace(',00', '')}</button>
        </div></div>
      <p class="preview" data-preview></p>
      <button class="btn" type="submit">${submitLabel}</button>
      ${cat ? `
        <button class="btn secondary" type="button" data-move>Sposta nelle spese fisse</button>
        <button class="btn danger" type="button" data-del>Elimina voce</button>` : ''}
    </form>
  `, (root) => {
    const valueInput = $('input[name="value"]', root);

    const update = () => {
      root.querySelectorAll('[data-seg="kind"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === kind));
      root.querySelectorAll('[data-seg="base"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === base));
      $('[data-value-label]', root).textContent = kind === 'pct' ? 'Percentuale (%)' : 'Importo mensile (€)';
      valueInput.placeholder = kind === 'pct' ? 'es. 5' : 'es. 50,00';
      $('[data-base-field]', root).hidden = kind !== 'pct';

      const n = parseFloat(valueInput.value.replace(/\./g, kind === 'eur' ? '' : '.').replace(',', '.'));
      let budget = null;
      if (Number.isFinite(n) && n > 0) {
        if (kind === 'eur') budget = Math.round(n * 100);
        else budget = Math.round((n / 100) * (base === 'stipendio' ? m.salary : state.settings.baseCents));
      }
      const estNote = kind === 'pct' && base === 'stipendio' && salaryIsEstimate() ? ` <span class="muted">${estimateTag()}</span>` : '';
      $('[data-preview]', root).innerHTML = budget != null ? `Budget di questo mese: <b>${fmt(budget)}</b>${estNote}` : '&nbsp;';
    };

    root.querySelectorAll('[data-seg] button').forEach((b) => b.addEventListener('click', () => {
      if (b.parentElement.dataset.seg === 'kind') {
        if (kind !== b.dataset.v) valueInput.value = '';
        kind = b.dataset.v;
      } else {
        base = b.dataset.v;
      }
      update();
    }));
    valueInput.addEventListener('input', update);
    update();
    if (!cat && !fromFixed) $('input[name="name"]', root).focus();

    bindForm(root, async (fd) => {
      const body = { name: fd.get('name'), kind, value: fd.get('value'), base };
      if (fromFixed) {
        await api('POST', `api/fixed/${fromFixed.id}/to-variable`, body);
        return `${body.name} spostata nelle variabili`;
      }
      if (cat) {
        await api('PUT', `api/categories/${cat.id}`, body);
        return 'Voce aggiornata';
      }
      await api('POST', 'api/categories', body);
      return 'Voce creata';
    });

    $('[data-del]', root)?.addEventListener('click', () => confirmAndRun(
      `Eliminare la voce "${cat.name}"? Le spese già registrate restano nello storico.`,
      () => api('DELETE', `api/categories/${cat.id}`),
      'Voce eliminata',
    ));

    $('[data-move]', root)?.addEventListener('click', () => {
      const n = state.expenses.filter((e) => e.categoryId === cat.id).length;
      if (n > 0) {
        toast(`Questa voce ha ${n} ${n === 1 ? 'spesa' : 'spese'} questo mese: eliminale o spostale su un'altra voce prima di trasformarla in fissa`, true);
        return;
      }
      fixedSheet(null, { fromCat: cat });
    });
  });
}

// --- spesa fissa ---

// fromCat: voce variabile da trasformare in spesa fissa
function fixedSheet(f = null, { fromCat = null } = {}) {
  let title = f ? 'Modifica spesa fissa' : 'Nuova spesa fissa';
  let sub = 'Importo che esce ogni mese';
  let submitLabel = f ? 'Salva' : 'Aggiungi';
  let name = f?.name ?? '';
  let amount = f ? fmtIn(f.amount) : '';
  if (fromCat) {
    const budget = state.month.categories.find((c) => c.id === fromCat.id)?.budget ?? 0;
    title = 'Sposta nelle spese fisse';
    sub = `"${esc(fromCat.name)}" diventa un importo fisso mensile, senza tracciare le singole spese`;
    submitLabel = 'Sposta nelle fisse';
    name = fromCat.name;
    amount = budget > 0 ? fmtIn(budget) : '';
  }

  openSheet(`
    <h2>${title}</h2>
    <p class="sheet-sub">${sub}</p>
    <form>
      <label class="field"><span>Nome</span>
        <input class="input" name="name" maxlength="60" placeholder="es. Assicurazione" autocomplete="off" value="${esc(name)}"></label>
      <label class="field"><span>Importo mensile (€)</span>
        <input class="input num" name="amount" inputmode="decimal" required placeholder="0,00" autocomplete="off" value="${amount}"></label>
      <button class="btn" type="submit">${submitLabel}</button>
      ${f ? `
        <button class="btn secondary" type="button" data-move>Sposta nelle spese variabili</button>
        <button class="btn danger" type="button" data-del>Elimina</button>` : ''}
    </form>
  `, (root) => {
    if (!f && !fromCat) $('input', root).focus();
    $('[data-move]', root)?.addEventListener('click', () => categorySheet(null, { fromFixed: f }));
    bindForm(root, async (fd) => {
      const body = { name: fd.get('name'), amount: fd.get('amount') };
      if (fromCat) {
        await api('POST', `api/categories/${fromCat.id}/to-fixed`, body);
        return `${body.name} spostata nelle spese fisse`;
      }
      if (f) {
        const r = await api('PUT', `api/fixed/${f.id}`, body);
        if (r.warning) return r;
        return f.amount === parseEuro(body.amount) ? 'Spesa fissa aggiornata' : 'Spesa fissa aggiornata, voci variabili ricalcolate';
      }
      const r = await api('POST', 'api/fixed', body);
      return r.warning ? r : 'Spesa fissa aggiunta, voci variabili ricalcolate';
    });
    $('[data-del]', root)?.addEventListener('click', () => confirmAndRun(
      `Eliminare "${f.name}" dalle spese fisse?`,
      () => api('DELETE', `api/fixed/${f.id}`),
      'Spesa fissa eliminata, voci variabili ricalcolate',
    ));
  });
}

// ============ eventi ============

view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = Number(el.dataset.id);
  switch (el.dataset.act) {
    case 'reload': load(); break;
    case 'salary': salarySheet(); break;
    case 'toggle-fixed': showFixed = !showFixed; render(); break;
    case 'add': expenseSheet(findCategory(id)); break;
    case 'detail': detailSheet(findCategory(id)); break;
    case 'new-cat': categorySheet(); break;
    case 'edit-cat': categorySheet(state.categories.find((c) => c.id === id)); break;
    case 'new-fixed': fixedSheet(); break;
    case 'edit-fixed': fixedSheet(state.fixed.find((f) => f.id === id)); break;
    case 'move': move(el.dataset.kind, Number(el.dataset.i), Number(el.dataset.dir)); break;
    case 'history': historySheet(el.dataset.id); break;
    case 'goal': goalSheet(); break;
    case 'plan': planSheet(state.plans.find((p) => p.id === id)); break;
    case 'new-plan': planSheet(); break;
    case 'backup': saveBackup(); break;
    case 'restore': $('#restore-input').click(); break;
    case 'reset': resetAll(); break;
    case 'setup': showWelcome(); break;
    default:
  }
});

document.querySelectorAll('.tabbar button').forEach((btn) => btn.addEventListener('click', async () => {
  tab = btn.dataset.tab;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b === btn));
  window.scrollTo(0, 0);
  $('#fab').hidden = tab !== 'mese';
  if (tab === 'storico') {
    try { historyList = await api('GET', 'api/history'); } catch (err) { toast(err.message, true); }
  }
  render();
}));

// Quando l'app torna in primo piano ricarico i dati (es. è cambiato il mese)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sheetEl.hidden) load();
});

// ============ dati locali: backup, ripristino, mese chiuso ============

async function saveBackup() {
  try {
    const obj = await Backend.exportBackup();
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    await Report.deliver(blob, `Budget backup ${obj.exportedAt.slice(0, 10)}.json`);
    await load();
  } catch (err) { toast(err.message, true); }
}

$('#restore-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!window.confirm('Ripristinare questo backup? I dati attuali verranno sostituiti.')) return;
  try {
    await Backend.importBackup(JSON.parse(await file.text()));
    toast('Backup ripristinato');
    await load();
  } catch (err) {
    toast(err instanceof SyntaxError ? 'Questo file non è un backup valido' : err.message, true);
  }
});

async function resetAll() {
  if (!window.confirm('Cancellare TUTTI i dati e ricominciare da capo? Consiglio: prima salva un backup.')) return;
  if (!window.confirm('Sicuro? Questa operazione non si può annullare.')) return;
  await Backend.reset();
  ['userName', 'accent', 'icons'].forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignora */ } });
  location.reload();
}

// Mese appena chiuso (succede alla prima apertura del mese nuovo): report + backup
async function monthClosedSheet(list) {
  const snaps = await Promise.all(list.map((m) => api('GET', `api/history/${m.id}`)));
  openSheet(`
    <h2>${snaps.length === 1 ? `${esc(snaps[0].label)} è chiuso` : 'Mesi chiusi'}</h2>
    <p class="sheet-sub">Il nuovo mese è partito da zero. Salva il report e un backup, ad esempio su iCloud Drive.</p>
    ${snaps.map((s) => `
      <div class="list" style="margin-bottom:10px">
        <div class="list-row"><div class="grow"><b>${esc(s.label)}</b></div><span class="amount num ${s.avanzo < 0 ? 'red' : 'green'}">Avanzo ${fmt(s.avanzo)}</span></div>
        ${s.overList.length ? `<div class="list-row"><div class="grow sub red">Sforato: ${s.overList.map((o) => esc(o.name)).join(', ')}</div></div>` : ''}
      </div>
      <div class="btn-row" style="margin-bottom:14px">
        <button class="btn" type="button" data-pdf="${s.id}">Report PDF</button>
        <button class="btn secondary" type="button" data-csv="${s.id}">CSV</button>
      </div>`).join('')}
    <button class="btn secondary" type="button" data-bk>Salva anche un backup</button>
  `, (root) => {
    const byId = Object.fromEntries(snaps.map((s) => [s.id, s]));
    root.querySelectorAll('[data-pdf]').forEach((b) => b.addEventListener('click', () => Report.pdf(byId[b.dataset.pdf])));
    root.querySelectorAll('[data-csv]').forEach((b) => b.addEventListener('click', () => Report.csv(byId[b.dataset.csv])));
    $('[data-bk]', root).addEventListener('click', saveBackup);
  });
}

// ============ aggiornamenti: "Nuova versione disponibile · Aggiorna" ============

function showUpdateBanner(onUpdate) {
  const el = $('#update-banner');
  el.hidden = false;
  $('button', el).onclick = onUpdate;
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => showUpdateBanner(() => worker.postMessage('skipWaiting'));
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // controlla aggiornamenti ogni volta che l'app torna in primo piano
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

// ============ ANTEPRIMA iOS 27: elementi extra ============

// Pulsante rapido "+" accanto alla barra: scegli la voce e aggiungi la spesa
function quickAddSheet() {
  const cats = state.month.categories.filter((c) => !c.archived);
  openSheet(`
    <h2>Nuova spesa</h2>
    <p class="sheet-sub">Scegli la voce</p>
    <div class="list">
      ${cats.map((c, i) => `
        <button class="list-row" data-cat="${c.id}">
          <span class="cat-icon sm">${iconFor(c.name)}</span>
          <div class="grow">
            <div class="title">${esc(c.name)}</div>
            <div class="sub ${c.over ? 'red' : ''}">${c.over ? `Sforato di ${fmt(c.spent - c.budget)}` : `Restano ${fmt(c.remaining)}`}</div>
          </div>
          <span class="chev">›</span>
        </button>`).join('')}
    </div>
  `, (root) => {
    root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      expenseSheet(findCategory(Number(b.dataset.cat)));
    }));
  });
}

$('#fab').addEventListener('click', () => { if (state) quickAddSheet(); });
$('.sheet-close').addEventListener('click', () => dismissSheet());

// Barra superiore uniforme: compare quando il titolo grande scorre sotto
const topbar = $('#topbar');
window.addEventListener('scroll', () => {
  const h1 = $('.page-head h1', view);
  topbar.textContent = h1 ? h1.textContent : '';
  topbar.classList.toggle('show', window.scrollY > 48);
}, { passive: true });

load();
