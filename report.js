'use strict';

// ============================================================
// Report mensili generati sul telefono: CSV e PDF (generatore PDF interno, senza librerie).
// ============================================================

const Report = (() => {
  const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

  const euro = (cents) => {
    const neg = cents < 0;
    const c = Math.abs(Math.round(cents));
    return `${neg ? '-' : ''}${String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(c % 100).padStart(2, '0')} €`;
  };
  const num = (cents) => {
    const neg = cents < 0;
    const c = Math.abs(Math.round(cents));
    return `${neg ? '-' : ''}${Math.floor(c / 100)},${String(c % 100).padStart(2, '0')}`;
  };
  const pct = (v) => `${String(Math.round(v * 100) / 100).replace('.', ',')}%`;
  const date = (iso) => iso.slice(0, 10).split('-').reverse().join('/');

  const baseName = (snap) => `${snap.id} ${MESI[Number(snap.id.slice(5, 7)) - 1]}`;

  function describeCategory(c, baseCents) {
    if (c.kind === 'eur') return 'importo fisso';
    if (c.base === 'stipendio') return `${pct(c.value)} dello stipendio`;
    return `${pct(c.value)} di ${euro(baseCents)}`;
  }

  // Divisione dell'avanzo salvata alla chiusura: [[nome, importo]]
  function savingsRows(snap) {
    if (!snap.savings) return [];
    const names = snap.savings.names || {};
    return [
      ['Fondo emergenza', snap.savings.emergency],
      ...Object.entries(snap.savings.plans || {}).map(([id, amt]) => [names[id] || 'Piano', amt]),
    ];
  }

  function salaryNote(snap) {
    if (snap.salarySource === 'reale') return null;
    if (snap.salarySource === 'media') {
      return `ATTENZIONE: stipendio non inserito, usata la media ${snap.salaryMonths === 1 ? "dell'ultimo mese" : `degli ultimi ${snap.salaryMonths} mesi`}`;
    }
    return 'ATTENZIONE: stipendio non inserito, usata la base di riferimento';
  }

  // ---------- CSV ----------

  function csv(snap) {
    const rows = [];
    const cell = (v) => {
      const s = String(v ?? '');
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const add = (...cells) => rows.push(cells.map(cell).join(';'));

    add('Report budget', snap.label);
    add('Chiuso il', date(snap.closedOn));
    add();
    add('ENTRATE');
    add('Stipendio', num(snap.salary), salaryNote(snap) ?? '');
    add();
    add('SPESE FISSE', 'Importo');
    snap.fixed.forEach((f) => add(f.name, num(f.amount)));
    add('Totale spese fisse', num(snap.fixedTotal));
    add();
    add('SPESE VARIABILI', 'Regola', 'Budget', 'Speso', 'Differenza', 'Stato');
    snap.categories.forEach((c) => add(
      c.name, describeCategory(c, snap.baseCents), num(c.budget), num(c.spent), num(c.remaining),
      c.over ? `SFORATO (+${pct(c.overPct ?? 0)})` : 'OK',
    ));
    add('Totale spese variabili', '', num(snap.varBudget), num(snap.varSpent), num(snap.varBudget - snap.varSpent));
    add();
    if (snap.overList.length) {
      add('VOCI SFORATE', 'Oltre il budget');
      snap.overList.forEach((o) => add(o.name, num(o.over)));
    } else {
      add('VOCI SFORATE', 'nessuna');
    }
    add();
    add('AVANZO DEL MESE', num(snap.avanzo));
    savingsRows(snap).forEach(([name, amt]) => add(`  a ${name}`, num(amt)));
    add();
    add('DETTAGLIO SPESE', 'Voce', 'Importo', 'Nota');
    snap.expenses.forEach((e) => add(date(e.date), e.category, num(e.amount), e.note));
    return new Blob([`﻿${rows.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  }

  // ---------- generatore PDF minimo (Helvetica, A4) ----------

  // Larghezze Helvetica / Helvetica-Bold per i caratteri 32..126 (millesimi di em)
  const W_REG = '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'.split(',').map(Number);
  const W_BOLD = '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584'.split(',').map(Number);

  function charWidth(ch, bold) {
    const table = bold ? W_BOLD : W_REG;
    let code = ch.charCodeAt(0);
    if (code > 126) {
      if (ch === '€') return 556;
      const base = ch.normalize('NFD')[0];
      code = base.charCodeAt(0);
      if (code > 126 || code < 32) return 556;
    }
    return table[code - 32] ?? 556;
  }

  const textWidth = (s, size, bold) => [...s].reduce((w, ch) => w + charWidth(ch, bold), 0) * size / 1000;

  // Carattere -> byte WinAnsi
  const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '−': 0x2d };
  function encode(s) {
    let out = '';
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      let b;
      if (code < 128) b = code;
      else if (WIN[ch] != null) b = WIN[ch];
      else if (code >= 160 && code <= 255) b = code;
      else b = 63; // ?
      const c = String.fromCharCode(b);
      out += c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
    }
    return out;
  }

  const hex = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

  class Doc {
    constructor() {
      this.pages = [];
      this.addPage();
    }

    addPage() {
      this.ops = [];
      this.pages.push(this.ops);
      this.y = 50;
    }

    ensure(h) {
      if (this.y + h > 790) this.addPage();
    }

    // Testo con angolo in alto a sinistra in (x, y); align 'right' allinea a x+width
    text(str, x, y, { size = 10, bold = false, color = '#1c1c1e', width = null, align = 'left' } = {}) {
      let s = String(str);
      if (width) {
        while (s.length > 1 && textWidth(s, size, bold) > width) s = `${s.slice(0, -2)}…`;
      }
      const w = textWidth(s, size, bold);
      const tx = align === 'right' && width ? x + width - w : x;
      const ty = 842 - y - size * 0.8;
      this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${hex(color)} rg ${tx.toFixed(2)} ${ty.toFixed(2)} Td (${encode(s)}) Tj ET`);
    }

    line(x1, y, x2, color = '#d1d1d6') {
      const py = (842 - y).toFixed(2);
      this.ops.push(`${hex(color)} RG 0.5 w ${x1} ${py} m ${x2} ${py} l S`);
    }

    bytes() {
      const objs = [];
      const add = (s) => { objs.push(s); return objs.length; };
      add('<< /Type /Catalog /Pages 2 0 R >>');
      add('PAGES');
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const kids = [];
      for (const ops of this.pages) {
        const stream = ops.join('\n');
        const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
        kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`));
      }
      objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

      let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
      const offsets = [];
      objs.forEach((o, i) => {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${o}\nendobj\n`;
      });
      const xref = out.length;
      out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
      offsets.forEach((o) => { out += `${String(o).padStart(10, '0')} 00000 n \n`; });
      out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      const buf = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i++) buf[i] = out.charCodeAt(i) & 0xff;
      return buf;
    }
  }

  const C = { text: '#1c1c1e', muted: '#6e6e73', red: '#c62828', green: '#1b7f4b', line: '#d1d1d6' };
  const L = 50;
  const R = 545;

  function pdf(snap) {
    const d = new Doc();

    const section = (title) => {
      d.ensure(50);
      d.y += 16;
      d.text(title, L, d.y, { size: 11, bold: true, color: C.muted });
      d.y += 16;
      d.line(L, d.y, R, C.line);
      d.y += 8;
    };

    const row = (cols, { size = 10, gap = 5 } = {}) => {
      d.ensure(size + gap + 4);
      for (const c of cols) d.text(c.text, c.x, d.y, { size, bold: c.bold, color: c.color || C.text, width: c.w, align: c.align });
      d.y += size + gap + 2;
    };

    const kv = (label, value, o = {}) => row([
      { text: label, x: L, w: 320, bold: o.bold, color: o.color },
      { text: value, x: 380, w: R - 380, align: 'right', bold: o.bold, color: o.color },
    ], o);

    d.text(`Budget ${snap.label}`, L, d.y, { size: 22, bold: true });
    d.y += 28;
    d.text(`Mese chiuso il ${date(snap.closedOn)}`, L, d.y, { size: 9, color: C.muted });
    d.y += 12;

    section('ENTRATE');
    kv('Stipendio', euro(snap.salary), { bold: true });
    const note = salaryNote(snap);
    if (note) row([{ text: note, x: L, w: R - L, color: C.red }], { size: 9 });

    section('SPESE FISSE');
    snap.fixed.forEach((f) => kv(f.name, euro(f.amount)));
    kv('Totale spese fisse', euro(snap.fixedTotal), { bold: true });

    section('SPESE VARIABILI');
    const cx = { budget: 290, spent: 375, diff: 460 };
    const cw = 80;
    row([
      { text: 'Voce', x: L, w: 230, color: C.muted },
      { text: 'Budget', x: cx.budget, w: cw, align: 'right', color: C.muted },
      { text: 'Speso', x: cx.spent, w: cw, align: 'right', color: C.muted },
      { text: 'Differenza', x: cx.diff, w: R - cx.diff, align: 'right', color: C.muted },
    ], { size: 9 });
    snap.categories.forEach((c) => {
      const color = c.over ? C.red : C.text;
      row([
        { text: `${c.name}${c.over ? '  - SFORATO' : ''}`, x: L, w: 235, color, bold: c.over },
        { text: euro(c.budget), x: cx.budget, w: cw, align: 'right' },
        { text: euro(c.spent), x: cx.spent, w: cw, align: 'right', color },
        { text: euro(c.remaining), x: cx.diff, w: R - cx.diff, align: 'right', color: c.over ? C.red : C.green },
      ], { gap: 1 });
      row([{ text: describeCategory(c, snap.baseCents), x: L, w: 230, color: C.muted }], { size: 8, gap: 5 });
    });
    row([
      { text: 'Totale spese variabili', x: L, w: 230, bold: true },
      { text: euro(snap.varBudget), x: cx.budget, w: cw, align: 'right', bold: true },
      { text: euro(snap.varSpent), x: cx.spent, w: cw, align: 'right', bold: true },
      { text: euro(snap.varBudget - snap.varSpent), x: cx.diff, w: R - cx.diff, align: 'right', bold: true },
    ]);

    section('VOCI SFORATE');
    if (snap.overList.length === 0) {
      row([{ text: 'Nessuna voce sforata questo mese.', x: L, w: R - L, color: C.green }]);
    } else {
      snap.overList.forEach((o) => kv(`${o.name}${o.overPct != null ? ` (+${pct(o.overPct)})` : ''}`, `+${euro(o.over)}`, { color: C.red, bold: true }));
    }

    section('AVANZO DEL MESE');
    kv('Avanzo', euro(snap.avanzo), { bold: true, size: 14, color: snap.avanzo < 0 ? C.red : C.text });
    row([{
      text: snap.savings
        ? 'Stipendio - spese fisse - spese variabili effettive, diviso così:'
        : 'Stipendio - spese fisse - spese variabili effettive.',
      x: L, w: R - L, color: C.muted,
    }], { size: 8 });
    savingsRows(snap).forEach(([name, amt]) => kv(`  ${name}`, euro(amt)));

    section(`DETTAGLIO SPESE (${snap.expenses.length})`);
    if (snap.expenses.length === 0) row([{ text: 'Nessuna spesa registrata.', x: L, w: R - L, color: C.muted }]);
    snap.expenses.forEach((e) => row([
      { text: date(e.date), x: L, w: 62, color: C.muted },
      { text: e.category, x: 118, w: 150 },
      { text: e.note || '', x: 272, w: 178, color: C.muted },
      { text: euro(e.amount), x: 455, w: R - 455, align: 'right' },
    ], { size: 9, gap: 3 }));

    return new Blob([d.bytes()], { type: 'application/pdf' });
  }

  // ---------- condivisione / download ----------

  async function deliver(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  return {
    pdf: (snap) => deliver(pdf(snap), `${baseName(snap)}.pdf`),
    csv: (snap) => deliver(csv(snap), `${baseName(snap)}.csv`),
    deliver,
    buildPdf: pdf,
    buildCsv: csv,
  };
})();
