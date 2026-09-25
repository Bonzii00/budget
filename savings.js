'use strict';

// ============================================================
// Piani di risparmio: fondo emergenza (priorità) + piani in più (viaggi, auto, investimenti...).
// File IDENTICO in anteprima/server/savings.js e condivisa/savings.js: modificarli insieme.
// Importi sempre in centesimi.
//
// Divisione dell'avanzo di un mese:
//   1. finché il fondo emergenza non è completo riceve per primo la sua quota;
//   2. poi i piani attivi, in ordine, ognuno fino alla sua quota (e fino al suo obiettivo, se c'è);
//   3. quello che resta va al fondo emergenza;
//   un mese in perdita pesa sul fondo emergenza.
// Un piano "dopo" parte solo quando il fondo emergenza è completo.
// La divisione di ogni mese chiuso viene salvata nello snapshot, così cambiare le quote non riscrive il passato.
// ============================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Savings = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const MILESTONES = [
    [0.5, 'Primo salvagente'],
    [1, 'Un mese al sicuro'],
    [1.5, 'Un mese e mezzo'],
    [2, 'Due mesi tranquillo'],
    [2.5, 'Fondo completo'],
  ];

  function addMonths(id, n) {
    const [y, m] = id.split('-').map(Number);
    const t = y * 12 + (m - 1) + n;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  }

  // b - a, in mesi
  function monthDiff(a, b) {
    const [ya, ma] = a.split('-').map(Number);
    const [yb, mb] = b.split('-').map(Number);
    return (yb * 12 + mb) - (ya * 12 + ma);
  }

  const emergencyQuota = (settings, target) => Math.ceil(Math.max(0, target - settings.goalInitial) / settings.goalMonths);

  // Il piano riceve soldi in questo mese?
  function isActive(plan, monthId, emergencyComplete) {
    if (plan.startMonth > monthId) return false;
    if (plan.endMonth && monthId >= plan.endMonth) return false;
    return !plan.after || emergencyComplete;
  }

  // Saldi attuali: mesi chiusi (con la divisione salvata) meno i prelievi
  // closed: [{ id, avanzo, savings }] in ordine di mese, solo dall'inizio del piano
  function balances(ctx) {
    let emergency = ctx.settings.goalInitial;
    const plans = new Map(ctx.plans.map((p) => [p.id, 0]));
    for (const m of ctx.closed) {
      if (!m.savings) { emergency += m.avanzo; continue; } // mesi chiusi prima dei piani: tutto all'emergenza
      emergency += m.savings.emergency;
      for (const [id, amt] of Object.entries(m.savings.plans || {})) {
        if (plans.has(Number(id))) plans.set(Number(id), plans.get(Number(id)) + amt);
      }
    }
    for (const w of ctx.withdrawals) {
      if (plans.has(w.planId)) plans.set(w.planId, plans.get(w.planId) - w.amount);
    }
    return { emergency, plans };
  }

  // Divide l'avanzo di un mese tra fondo emergenza e piani
  function allocate(ctx, monthId, avanzo, bal = balances(ctx)) {
    const out = { emergency: 0, plans: {} };
    if (avanzo <= 0) { out.emergency = avanzo; return out; }
    const complete = bal.emergency >= ctx.target;
    let rest = avanzo;
    if (!complete) {
      out.emergency = Math.min(rest, emergencyQuota(ctx.settings, ctx.target));
      rest -= out.emergency;
    }
    for (const p of ctx.plans) {
      if (!isActive(p, monthId, complete) || rest <= 0) continue;
      const room = p.target ? Math.max(0, p.target - bal.plans.get(p.id)) : Infinity;
      const amt = Math.min(rest, p.monthly, room);
      if (amt > 0) { out.plans[p.id] = amt; rest -= amt; }
    }
    out.emergency += rest;
    return out;
  }

  // Quanto il piano prevede di mettere da parte in questo mese (per calcolare i budget delle voci).
  // Finché il fondo emergenza non è completo, le quote dei piani "dopo" restano comunque riservate
  // (quei soldi vanno all'emergenza): così i budget delle voci non cambiano quando il fondo si completa.
  function plannedSaving(ctx, month, bal = balances(ctx)) {
    // prima dell'inizio del piano conta già come il primo mese del piano
    const monthId = ctx.settings.goalStart && month < ctx.settings.goalStart ? ctx.settings.goalStart : month;
    const complete = bal.emergency >= ctx.target;
    let total = 0;
    if (!complete) {
      const waiting = ctx.plans
        .filter((p) => p.after && p.startMonth <= monthId && (!p.endMonth || monthId < p.endMonth))
        .reduce((a, p) => a + p.monthly, 0);
      total = Math.max(emergencyQuota(ctx.settings, ctx.target), waiting);
    }
    for (const p of ctx.plans) {
      if (!isActive(p, monthId, complete)) continue;
      const room = p.target ? Math.max(0, p.target - bal.plans.get(p.id)) : Infinity;
      total += Math.min(p.monthly, room);
    }
    return total;
  }

  // Stato completo per la schermata: fondo emergenza (stessa forma di prima) + piani
  function summary(ctx, current) {
    const s = ctx.settings;
    const bal = balances(ctx);
    const inPlan = current.id >= s.goalStart;
    const proj = inPlan ? allocate(ctx, current.id, current.avanzoPrevisto, bal) : { emergency: 0, plans: {} };
    const target = ctx.target;
    const saved = bal.emergency;
    const thisMonth = proj.emergency;
    const withThis = saved + thisMonth;
    const planMonthly = emergencyQuota(s, target);
    const contributions = ctx.closed.map((m) => (m.savings ? m.savings.emergency : m.avanzo));
    const savedClosed = contributions.reduce((a, b) => a + b, 0);
    // Ritmo per i mesi futuri: media reale dei mesi chiusi; senza storico, quello del piano
    const pace = contributions.length ? Math.round(savedClosed / contributions.length) : planMonthly;

    const etaFor = (amount) => {
      if (saved >= amount) return { reached: true, month: null };
      if (withThis >= amount) return { reached: false, month: current.id };
      if (pace <= 0) return { reached: false, month: null };
      return { reached: false, month: addMonths(current.id, Math.ceil((amount - withThis) / pace)) };
    };

    const planEnd = addMonths(s.goalStart, s.goalMonths - 1);
    const eta = etaFor(target);
    const milestones = MILESTONES
      .filter(([mult]) => mult <= s.goalMultiplier)
      .map(([mult, name]) => {
        const amount = Math.round(current.fixedTotal * mult);
        const e = etaFor(amount);
        return { mult, name, amount, reached: e.reached, eta: e.month, etaLabel: e.month ? ctx.monthLabel(e.month) : null };
      });

    const complete = saved >= target;
    const plans = ctx.plans.filter((p) => !p.endMonth || current.id < p.endMonth).map((p) => {
      const pSaved = bal.plans.get(p.id);
      const pThis = proj.plans[p.id] || 0;
      let status = 'attivo';
      if (p.target && pSaved >= p.target) status = 'completo';
      else if (p.after && !complete) status = 'in-attesa';
      else if (p.startMonth > current.id) status = 'da-iniziare';
      return {
        id: p.id,
        name: p.name,
        monthly: p.monthly,
        target: p.target,
        after: p.after,
        startMonth: p.startMonth,
        saved: pSaved,
        thisMonth: pThis,
        withThis: pSaved + pThis,
        status,
      };
    });

    return {
      goal: {
        target,
        multiplier: s.goalMultiplier,
        months: s.goalMonths,
        initial: s.goalInitial,
        start: s.goalStart,
        planEnd,
        planEndLabel: ctx.monthLabel(planEnd),
        planMonthly,
        saved,
        thisMonth,
        withThis,
        pace,
        closedCount: contributions.length,
        reached: eta.reached,
        eta: eta.month,
        etaLabel: eta.month ? ctx.monthLabel(eta.month) : null,
        // > 0 in anticipo sul piano, < 0 in ritardo
        monthsAhead: eta.month ? monthDiff(eta.month, planEnd) : null,
        milestones,
        plannedSaving: plannedSaving(ctx, current.id, bal),
      },
      plans,
    };
  }

  return { balances, allocate, plannedSaving, summary, emergencyQuota, addMonths, monthDiff };
}));
