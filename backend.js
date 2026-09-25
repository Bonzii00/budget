'use strict';

// ============================================================
// Archivio LOCALE: tutti i dati restano su questo dispositivo (IndexedDB).
// Stessa logica del server della versione personale, portata nel browser.
// Importi sempre in centesimi (interi).
// ============================================================

const Backend = (() => {
  const SCHEMA = 2;
  const DATA_KEY = 'data';

  const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

  // Modello generico di voci variabili (riscalate dalla configurazione iniziale)
  const SEED_CATEGORIES = [
    ['Spesa alimentare', 'pct', 12],
    ['Trasporti', 'pct', 5],
    ['Ristoranti e uscite', 'pct', 6],
    ['Svago', 'pct', 4],
    ['Varie', 'pct', 3],
  ];

  let data = null;

  // ---------- errori ----------

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // ---------- archivio (IndexedDB, con ripiego su localStorage) ----------

  let dbPromise = null;
  function idb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('budget', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function storeGet(key) {
    try {
      const db = await idb();
      return await new Promise((resolve, reject) => {
        const r = db.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } catch {
      const raw = localStorage.getItem(`budget:${key}`);
      return raw ? JSON.parse(raw) : undefined;
    }
  }

  async function storePut(key, value) {
    try {
      const db = await idb();
      await new Promise((resolve, reject) => {
        const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(value, key);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    } catch {
      localStorage.setItem(`budget:${key}`, JSON.stringify(value));
    }
  }

  const save = () => storePut(DATA_KEY, data);

  function uuid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function fresh() {
    return {
      schema: SCHEMA,
      instanceId: uuid(),
      createdAt: new Date().toISOString(),
      settings: {
        baseCents: 0,
        avgMonths: 3,
        onboarded: false,
        goalMonths: 0,
        goalStart: null,
        goalInitial: 0,
        goalMultiplier: 2.5,
        lastBackup: null,
      },
      fixed: [],
      categories: SEED_CATEGORIES.map(([name, kind, value], i) => ({
        id: i + 1, name, kind, value, base: 'riferimento', sort: i, archived: false,
      })),
      months: {},
      expenses: [],
      plans: [],
      withdrawals: [],
      nextId: 100,
    };
  }

  // Aggiornamenti del formato dati: ogni passo porta da schema N a N+1
  const MIGRATIONS = {
    // 1 -> 2: piani di risparmio oltre al fondo emergenza
    1: (d) => ({ ...d, plans: d.plans || [], withdrawals: d.withdrawals || [], schema: 2 }),
  };

  function migrate(d) {
    while (d.schema < SCHEMA) {
      const step = MIGRATIONS[d.schema];
      if (!step) throw new Error(`Formato dati ${d.schema} non supportato`);
      d = step(d);
    }
    return d;
  }

  async function init() {
    try { await navigator.storage?.persist?.(); } catch { /* facoltativo */ }
    let d = await storeGet(DATA_KEY);
    if (!d) {
      data = fresh();
      await save();
      return;
    }
    if (d.schema < SCHEMA) {
      // copia di sicurezza prima di convertire i dati
      await storePut(`backup-schema-${d.schema}`, d);
      d = migrate(d);
      data = d;
      await save();
      return;
    }
    data = d;
  }

  const nextId = () => { data.nextId += 1; return data.nextId; };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  // ---------- date ----------

  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const currentMonthId = () => todayLocal().slice(0, 7);
  const monthLabel = (id) => `${MESI[Number(id.slice(5, 7)) - 1]} ${id.slice(0, 4)}`;
  function daysInMonth(id) {
    const [y, m] = id.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }
  function addMonths(id, n) {
    const [y, m] = id.split('-').map(Number);
    const t = y * 12 + (m - 1) + n;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  }
  function monthDiff(a, b) {
    const [ya, ma] = a.split('-').map(Number);
    const [yb, mb] = b.split('-').map(Number);
    return (yb * 12 + mb) - (ya * 12 + ma);
  }

  // ---------- validazione ----------

  function parseCents(value, { allowZero = false, field = 'Importo' } = {}) {
    let n;
    if (typeof value === 'number') {
      n = value;
    } else {
      let s = String(value ?? '').trim().replace(/[\s€]/g, '');
      if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '');
      s = s.replace(',', '.');
      if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new HttpError(400, `${field} non valido`);
      n = parseFloat(s);
    }
    const cents = Math.round(n * 100);
    if (!Number.isFinite(cents) || cents < 0 || (!allowZero && cents === 0) || cents > 100_000_000) {
      throw new HttpError(400, `${field} non valido`);
    }
    return cents;
  }

  function parsePct(value) {
    const s = String(value ?? '').trim().replace('%', '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new HttpError(400, 'Percentuale non valida');
    const n = parseFloat(s);
    if (n <= 0 || n > 100) throw new HttpError(400, 'La percentuale deve essere tra 0 e 100');
    return n;
  }

  function parseName(value) {
    const s = String(value ?? '').trim();
    if (!s || s.length > 60) throw new HttpError(400, 'Nome non valido');
    return s;
  }

  function parseId(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Id non valido');
    return n;
  }

  function parseCategoryBody(body) {
    const kind = body.kind === 'eur' ? 'eur' : 'pct';
    return {
      name: parseName(body.name),
      kind,
      value: kind === 'pct' ? parsePct(body.value) : parseCents(body.value, { field: 'Importo' }),
      base: body.base === 'stipendio' ? 'stipendio' : 'riferimento',
    };
  }

  function parseGoalMonths(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 60) throw new HttpError(400, 'Durata non valida (da 1 a 60 mesi)');
    return n;
  }

  // ---------- calcoli del mese ----------

  const bySort = (a, b) => a.sort - b.sort || a.id - b.id;
  const activeCategories = () => data.categories.filter((c) => !c.archived).sort(bySort);
  const fixedSorted = () => [...data.fixed].sort(bySort);
  const fixedTotal = () => data.fixed.reduce((acc, f) => acc + f.amount, 0);

  function ensureMonth(id) {
    if (!data.months[id]) data.months[id] = { salary: null, closedAt: null, snapshot: null };
  }

  function salaryEstimate(beforeId) {
    const s = data.settings;
    const rows = Object.entries(data.months)
      .filter(([id, m]) => id < beforeId && m.closedAt && m.salary != null)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, s.avgMonths);
    if (rows.length === 0) return { cents: s.baseCents, source: 'base', months: 0 };
    const sum = rows.reduce((acc, [, m]) => acc + m.salary, 0);
    return { cents: Math.round(sum / rows.length), source: 'media', months: rows.length };
  }

  function categoryBudget(cat, salaryCents, baseCents) {
    if (cat.kind === 'eur') return Math.round(cat.value);
    const base = cat.base === 'stipendio' ? salaryCents : baseCents;
    return Math.round((cat.value / 100) * base);
  }

  function computeMonth(id) {
    const s = data.settings;
    const row = data.months[id] || { salary: null };
    let salary;
    let salarySource;
    let salaryMonths = 0;
    if (row.salary != null) {
      salary = row.salary;
      salarySource = 'reale';
    } else {
      const est = salaryEstimate(id);
      salary = est.cents;
      salarySource = est.source;
      salaryMonths = est.months;
    }

    const fixed = fixedSorted().map(({ id: fid, name, amount }) => ({ id: fid, name, amount }));
    const fTotal = fixed.reduce((acc, f) => acc + f.amount, 0);

    const monthExp = data.expenses.filter((e) => e.month === id);
    const usedIds = new Set(monthExp.map((e) => e.categoryId));
    const cats = data.categories
      .filter((c) => !c.archived || usedIds.has(c.id))
      .sort((a, b) => Number(a.archived) - Number(b.archived) || bySort(a, b));

    const categories = cats.map((c) => {
      const budget = categoryBudget(c, salary, s.baseCents);
      const list = monthExp.filter((e) => e.categoryId === c.id);
      const spent = list.reduce((acc, e) => acc + e.amount, 0);
      const over = spent > budget;
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        value: c.value,
        base: c.base,
        archived: !!c.archived,
        budget,
        spent,
        count: list.length,
        remaining: budget - spent,
        over,
        overPct: over && budget > 0 ? Math.round(((spent - budget) / budget) * 1000) / 10 : null,
      };
    });

    const varBudget = categories.reduce((acc, c) => acc + c.budget, 0);
    const varSpent = categories.reduce((acc, c) => acc + c.spent, 0);
    const varProjected = categories.reduce((acc, c) => acc + Math.max(c.budget, c.spent), 0);

    return {
      id,
      label: monthLabel(id),
      days: daysInMonth(id),
      salary,
      salarySource,
      salaryMonths,
      baseCents: s.baseCents,
      fixed,
      fixedTotal: fTotal,
      categories,
      varBudget,
      varSpent,
      avanzo: salary - fTotal - varSpent,
      avanzoPrevisto: salary - fTotal - varProjected,
      overList: categories.filter((c) => c.over).map((c) => ({ name: c.name, over: c.spent - c.budget, overPct: c.overPct })),
    };
  }

  function monthExpenses(id) {
    const names = new Map(data.categories.map((c) => [c.id, c.name]));
    return data.expenses
      .filter((e) => e.month === id)
      .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1))
      .map((e) => ({ id: e.id, categoryId: e.categoryId, category: names.get(e.categoryId) ?? '?', amount: e.amount, note: e.note, date: e.date }));
  }

  function closeMonth(id) {
    const snapshot = computeMonth(id);
    snapshot.expenses = monthExpenses(id).reverse();
    snapshot.closedAt = new Date().toISOString();
    snapshot.closedOn = todayLocal();
    // Divisione dell'avanzo tra fondo emergenza e piani, fissata alla chiusura
    const s = data.settings;
    if (s.goalMonths && s.goalStart && id >= s.goalStart) {
      const ctx = savingsCtx(snapshot.fixedTotal);
      snapshot.savings = Savings.allocate(ctx, id, snapshot.avanzo);
      snapshot.savings.names = Object.fromEntries(ctx.plans.map((p) => [p.id, p.name]));
    }
    data.months[id].closedAt = snapshot.closedAt;
    data.months[id].snapshot = snapshot;
    return snapshot;
  }

  // Chiude i mesi passati ancora aperti (avviene all'apertura dell'app)
  function closePastMonths() {
    const current = currentMonthId();
    ensureMonth(current);
    const open = Object.keys(data.months).filter((id) => id < current && !data.months[id].closedAt).sort();
    return open.map((id) => closeMonth(id));
  }

  // ---------- fondo emergenza ----------

  // Contesto per savings.js. overrides: valori non ancora salvati (configurazione iniziale, modifica del piano)
  function savingsCtx(fTotal, overrides = {}) {
    const settings = { ...data.settings, ...overrides };
    const start = settings.goalStart || '9999-99';
    const closed = Object.entries(data.months)
      .filter(([id, m]) => m.closedAt && id >= start)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([, m]) => m.snapshot);
    return {
      settings,
      target: Math.round(fTotal * settings.goalMultiplier),
      plans: [...data.plans].sort(bySort),
      closed,
      withdrawals: data.withdrawals,
      monthLabel,
    };
  }

  // Stato del fondo emergenza (goal) e dei piani per la schermata
  function computeSavings(current) {
    const s = data.settings;
    if (!s.goalMonths || !s.goalStart) return { goal: null, plans: [] };
    const out = Savings.summary(savingsCtx(current.fixedTotal), current);
    const recent = [...data.withdrawals].sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
    for (const p of out.plans) {
      p.withdrawals = recent.filter((w) => w.planId === p.id).slice(0, 20)
        .map(({ id, planId, amount, note, date }) => ({ id, planId, amount, note, date }));
    }
    return out;
  }

  // Quanto mettere da parte in questo mese (fondo + piani attivi), per calcolare i budget delle voci
  function plannedSavingFor(fTotal, overrides = {}) {
    const s = { ...data.settings, ...overrides };
    if (!s.goalMonths) return 0;
    return Savings.plannedSaving(savingsCtx(fTotal, overrides), currentMonthId());
  }

  function scaleCategories(baseCents, fTotal, monthlySaving) {
    const cats = activeCategories();
    const eurTotal = cats.filter((c) => c.kind === 'eur').reduce((acc, c) => acc + c.value, 0);
    const pctCats = cats.filter((c) => c.kind === 'pct');
    const pctSum = pctCats.reduce((acc, c) => acc + c.value, 0);
    const available = baseCents - fTotal - monthlySaving - eurTotal;
    if (pctSum === 0) return;
    if (available <= 0) throw new HttpError(400, 'Con questo piano non resta niente per le spese variabili: scegli più mesi');
    const factor = ((available / baseCents) * 100) / pctSum;
    for (const c of pctCats) c.value = Math.max(0.01, Math.floor(c.value * factor * 100) / 100);
  }

  // Dopo un cambio a spese fisse o piani: riscala le voci in percentuale come nella configurazione iniziale.
  // Se non resta spazio il cambio si salva lo stesso, le voci restano com'erano e l'app lo segnala.
  function rescaleCategories() {
    const s = data.settings;
    if (!s.baseCents) return undefined;
    const fTotal = fixedTotal();
    try {
      scaleCategories(s.baseCents, fTotal, plannedSavingFor(fTotal));
      return undefined;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return { warning: 'Salvato, ma non resta abbastanza per le voci variabili: riduci qualche voce, una quota di risparmio o allunga il piano del fondo' };
    }
  }

  function history() {
    return Object.entries(data.months)
      .filter(([, m]) => m.closedAt)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([, m]) => {
        const s = m.snapshot;
        return {
          id: s.id, label: s.label, salary: s.salary, salarySource: s.salarySource, fixedTotal: s.fixedTotal,
          varBudget: s.varBudget, varSpent: s.varSpent, avanzo: s.avanzo, overCount: s.overList.length,
        };
      });
  }

  // ---------- "API" (stessi percorsi della versione con server) ----------

  function openMonth() {
    const closed = closePastMonths();
    return { month: currentMonthId(), closed };
  }

  function findCategory(id) {
    const c = data.categories.find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'Voce non trovata');
    return c;
  }

  function findFixed(id) {
    const f = data.fixed.find((x) => x.id === id);
    if (!f) throw new HttpError(404, 'Spesa fissa non trovata');
    return f;
  }

  function expenseInOpenMonth(id) {
    const { month } = openMonth();
    const e = data.expenses.find((x) => x.id === id);
    if (!e) throw new HttpError(404, 'Spesa non trovata');
    if (e.month !== month) throw new HttpError(409, 'Il mese di questa spesa è già chiuso');
    return e;
  }

  function parseExpenseDate(date, month) {
    const d = date ? String(date) : todayLocal();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d.slice(0, 7) !== month) throw new HttpError(400, 'La data deve essere nel mese corrente');
    return d;
  }

  const nextSort = (list) => list.reduce((m, x) => Math.max(m, x.sort), -1) + 1;
  const hasExpenses = (catId, month) => data.expenses.some((e) => e.categoryId === catId && (!month || e.month === month));

  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

  on('GET', 'state', () => {
    const { month, closed } = openMonth();
    const computed = computeMonth(month);
    const savings = computeSavings(computed);
    return {
      today: todayLocal(),
      month: computed,
      goal: savings.goal,
      plans: savings.plans,
      expenses: monthExpenses(month),
      settings: { ...data.settings, instanceId: data.instanceId },
      categories: activeCategories(),
      fixed: fixedSorted(),
      justClosed: closed.map((s) => ({ id: s.id, label: s.label })),
    };
  });

  on('PUT', 'salary', (b) => {
    const { month } = openMonth();
    data.months[month].salary = b.amount == null || b.amount === '' ? null : parseCents(b.amount, { field: 'Stipendio' });
  });

  on('POST', 'expenses', (b) => {
    const { month } = openMonth();
    const categoryId = parseId(b.categoryId);
    if (findCategory(categoryId).archived) throw new HttpError(400, 'Voce eliminata');
    data.expenses.push({
      id: nextId(),
      month,
      categoryId,
      amount: parseCents(b.amount),
      note: String(b.note ?? '').trim().slice(0, 120),
      date: parseExpenseDate(b.date, month),
      createdAt: new Date().toISOString(),
    });
  });

  on('PUT', 'expenses/(\\d+)', (b, [id]) => {
    const e = expenseInOpenMonth(parseId(id));
    const categoryId = b.categoryId != null ? parseId(b.categoryId) : e.categoryId;
    findCategory(categoryId);
    Object.assign(e, {
      categoryId,
      amount: parseCents(b.amount),
      note: String(b.note ?? '').trim().slice(0, 120),
      date: parseExpenseDate(b.date, e.month),
    });
  });

  on('DELETE', 'expenses/(\\d+)', (b, [id]) => {
    const e = expenseInOpenMonth(parseId(id));
    data.expenses = data.expenses.filter((x) => x !== e);
  });

  on('POST', 'categories', (b) => {
    const c = parseCategoryBody(b);
    data.categories.push({ id: nextId(), ...c, sort: nextSort(data.categories), archived: false });
  });

  on('PUT', 'categories/(\\d+)', (b, [id]) => {
    Object.assign(findCategory(parseId(id)), parseCategoryBody(b));
  });

  on('DELETE', 'categories/(\\d+)', (b, [id]) => {
    const c = findCategory(parseId(id));
    if (hasExpenses(c.id)) c.archived = true;
    else data.categories = data.categories.filter((x) => x !== c);
  });

  on('POST', 'categories/(\\d+)/to-fixed', (b, [id]) => {
    const { month } = openMonth();
    const c = findCategory(parseId(id));
    const name = parseName(b.name);
    const amount = parseCents(b.amount);
    const n = data.expenses.filter((e) => e.categoryId === c.id && e.month === month).length;
    if (n > 0) throw new HttpError(409, `Questa voce ha ${n} ${n === 1 ? 'spesa' : 'spese'} questo mese: eliminale o spostale su un'altra voce prima di trasformarla in fissa`);
    if (hasExpenses(c.id)) c.archived = true;
    else data.categories = data.categories.filter((x) => x !== c);
    data.fixed.push({ id: nextId(), name, amount, sort: nextSort(data.fixed) });
  });

  on('POST', 'fixed', (b) => {
    data.fixed.push({ id: nextId(), name: parseName(b.name), amount: parseCents(b.amount), sort: nextSort(data.fixed) });
    return rescaleCategories();
  });

  on('PUT', 'fixed/(\\d+)', (b, [id]) => {
    const f = findFixed(parseId(id));
    const name = parseName(b.name);
    const amount = parseCents(b.amount);
    const changed = amount !== f.amount;
    Object.assign(f, { name, amount });
    return changed ? rescaleCategories() : undefined;
  });

  on('DELETE', 'fixed/(\\d+)', (b, [id]) => {
    const f = findFixed(parseId(id));
    data.fixed = data.fixed.filter((x) => x !== f);
    return rescaleCategories();
  });

  on('POST', 'fixed/(\\d+)/to-variable', (b, [id]) => {
    const f = findFixed(parseId(id));
    const c = parseCategoryBody(b);
    data.fixed = data.fixed.filter((x) => x !== f);
    data.categories.push({ id: nextId(), ...c, sort: nextSort(data.categories), archived: false });
  });

  for (const [path, key] of [['categories/order', 'categories'], ['fixed/order', 'fixed']]) {
    on('POST', path, (b) => {
      const ids = Array.isArray(b.ids) ? b.ids.map(parseId) : [];
      ids.forEach((id, i) => {
        const item = data[key].find((x) => x.id === id);
        if (item) item.sort = i;
      });
    });
  }

  // ---------- piani di risparmio ----------

  function parsePlanBody(b) {
    return {
      name: parseName(b.name),
      monthly: parseCents(b.monthly, { field: 'Quota al mese' }),
      target: b.target == null || String(b.target).trim() === '' ? null : parseCents(b.target, { field: 'Obiettivo' }),
      after: b.after === true,
    };
  }

  function findPlan(id) {
    const p = data.plans.find((x) => x.id === id && !x.endMonth);
    if (!p) throw new HttpError(404, 'Piano non trovato');
    return p;
  }

  on('POST', 'plans', (b) => {
    const { month } = openMonth();
    if (!data.settings.goalStart) throw new HttpError(400, 'Configura prima il fondo emergenza');
    data.plans.push({ id: nextId(), ...parsePlanBody(b), startMonth: month, endMonth: null, sort: nextSort(data.plans) });
    return rescaleCategories();
  });

  on('PUT', 'plans/(\\d+)', (b, [id]) => {
    const p = findPlan(parseId(id));
    const next = parsePlanBody(b);
    const changed = next.monthly !== p.monthly || next.target !== p.target || next.after !== p.after;
    Object.assign(p, next);
    return changed ? rescaleCategories() : undefined;
  });

  // Se il piano ha già ricevuto soldi resta nei mesi passati e smette di riceverne da questo mese
  on('DELETE', 'plans/(\\d+)', (b, [id]) => {
    const { month } = openMonth();
    const p = findPlan(parseId(id));
    const used = p.startMonth < month || data.withdrawals.some((w) => w.planId === p.id);
    if (used) p.endMonth = month;
    else data.plans = data.plans.filter((x) => x !== p);
    return rescaleCategories();
  });

  // Prelievo: soldi del piano usati (es. il viaggio)
  on('POST', 'plans/(\\d+)/withdraw', (b, [id]) => {
    const { month } = openMonth();
    const p = findPlan(parseId(id));
    const amount = parseCents(b.amount);
    const available = Math.max(0, computeSavings(computeMonth(month)).plans.find((x) => x.id === p.id)?.saved ?? 0);
    if (amount > available) throw new HttpError(400, `Nel piano ci sono ${(available / 100).toFixed(2).replace('.', ',')} €`);
    data.withdrawals.push({
      id: nextId(),
      planId: p.id,
      amount,
      note: String(b.note ?? '').trim().slice(0, 120),
      date: parseExpenseDate(b.date, month),
      createdAt: new Date().toISOString(),
    });
  });

  on('DELETE', 'withdrawals/(\\d+)', (b, [id]) => {
    const { month } = openMonth();
    const w = data.withdrawals.find((x) => x.id === parseId(id));
    if (!w) throw new HttpError(404, 'Prelievo non trovato');
    if (w.date.slice(0, 7) !== month) throw new HttpError(409, 'Il mese di questo prelievo è già chiuso');
    data.withdrawals = data.withdrawals.filter((x) => x !== w);
  });

  on('PUT', 'settings', (b) => {
    const baseCents = parseCents(b.base, { field: 'Base di riferimento' });
    const avgMonths = Number(b.avgMonths);
    if (!Number.isInteger(avgMonths) || avgMonths < 1 || avgMonths > 24) throw new HttpError(400, 'Mesi per la media: da 1 a 24');
    Object.assign(data.settings, { baseCents, avgMonths });
  });

  on('GET', 'history', () => {
    openMonth();
    return history();
  });

  on('GET', 'history/(\\d{4}-\\d{2})', (b, [id]) => {
    const m = data.months[id];
    if (!m || !m.closedAt) throw new HttpError(404, 'Mese non trovato o non ancora chiuso');
    return m.snapshot;
  });

  on('POST', 'setup', (b) => {
    const { month } = openMonth();
    const base = parseCents(b.base, { field: 'Stipendio medio' });
    const months = parseGoalMonths(b.months);
    const initial = parseCents(b.initial ?? 0, { allowZero: true, field: 'Già da parte' });
    const fixed = (Array.isArray(b.fixed) ? b.fixed : []).map((f) => ({
      name: parseName(f.name),
      amount: parseCents(f.amount, { field: `Importo di "${f.name}"` }),
    }));
    if (fixed.length === 0) throw new HttpError(400, 'Inserisci almeno una spesa fissa');
    const fTotal = fixed.reduce((acc, f) => acc + f.amount, 0);
    const monthly = plannedSavingFor(fTotal, { goalMonths: months, goalInitial: initial, goalStart: month });
    // se qualcosa fallisce, request() riporta i dati com'erano
    data.settings.baseCents = base;
    data.fixed = fixed.map((f, i) => ({ id: nextId(), ...f, sort: i }));
    if (b.recalc !== false) scaleCategories(base, fTotal, monthly);
    Object.assign(data.settings, { goalMonths: months, goalInitial: initial, goalStart: month, onboarded: true });
  });

  on('PUT', 'goal', (b) => {
    const { month } = openMonth();
    const months = parseGoalMonths(b.months);
    const initial = parseCents(b.initial ?? 0, { allowZero: true, field: 'Già da parte' });
    if (b.recalc) {
      const saving = plannedSavingFor(fixedTotal(), { goalMonths: months, goalInitial: initial, goalStart: data.settings.goalStart || month });
      scaleCategories(data.settings.baseCents, fixedTotal(), saving);
    }
    if (!data.settings.goalStart) data.settings.goalStart = month;
    Object.assign(data.settings, { goalMonths: months, goalInitial: initial });
  });

  // Esegue una richiesta: su errore i dati tornano com'erano
  let queue = Promise.resolve();
  function request(method, url, body = {}) {
    const run = async () => {
      if (!data) await init();
      const path = url.replace(/^\/?api\//, '').replace(/\?.*$/, '');
      const route = routes.find((r) => r.method === method && r.re.test(path));
      if (!route) throw new HttpError(404, 'Non trovato');
      const before = JSON.stringify(data);
      let result;
      try {
        result = route.fn(body || {}, path.match(route.re).slice(1));
      } catch (err) {
        data = JSON.parse(before);
        throw err;
      }
      if (JSON.stringify(data) !== before) await save();
      return result === undefined ? { ok: true } : clone(result);
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  // ---------- backup ----------

  async function exportBackup() {
    if (!data) await init();
    data.settings.lastBackup = new Date().toISOString();
    await save();
    return { app: 'budget', schema: data.schema, exportedAt: data.settings.lastBackup, data: clone(data) };
  }

  async function importBackup(obj) {
    const d = obj?.app === 'budget' ? obj.data : null;
    if (!d || typeof d !== 'object' || !d.settings || !Array.isArray(d.expenses) || !d.months) {
      throw new HttpError(400, 'Questo file non è un backup di Budget');
    }
    if (d.schema > SCHEMA) throw new HttpError(400, "Backup creato con una versione più nuova dell'app: aggiorna prima l'app");
    await storePut('backup-prima-del-ripristino', data);
    data = migrate(d);
    await save();
  }

  async function reset() {
    await storePut('backup-prima-del-reset', data);
    data = fresh();
    await save();
  }

  return { init, request, exportBackup, importBackup, reset, monthLabel, HttpError };
})();
