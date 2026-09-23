(function () {
  'use strict';

  // ---------- Constants ----------

  var DAYS = [30, 60, 90, 120, 150, 180];
  var DAY_MS = 24 * 60 * 60 * 1000;
  var TOMBSTONE_MS = 30 * DAY_MS;
  var SAVE_DELAY = 800;
  var RETRY_DELAY = 5000;
  var PULL_MS = 60000;
  var POLL_MS = 15000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Which credit line this page is for, from the address (/kapital, /banco-azteca).
  var LINES = {
    kapital: 'Kapital',
    'banco-azteca': 'Banco Azteca'
  };
  var LINE = (window.location.pathname.replace(/^\/+|\/+$/g, '') || 'kapital').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LINES, LINE)) LINE = 'kapital';
  var BANK = LINES[LINE];
  var RECORD_URL = '/api/lines/' + LINE + '/record';
  // Kapital keeps the key it always had so nobody's collapsed state resets.
  var COLLAPSE_KEY = LINE === 'kapital' ? 'kapital.collapsed' : 'kapital.collapsed.' + LINE;

  // ---------- State ----------

  var record = emptyRecord();
  var version = 0;
  var loaded = false;

  var dirty = false;          // local edits not yet on the server
  var inFlight = false;       // a PUT is running
  var saveTimer = null;       // debounce timer
  var retryTimer = null;      // retry after a network failure
  var pulling = false;
  var missedChange = false;   // a change event arrived while saving
  var pendingReason = '';     // 'restore' or 'clear' until the replacing save reaches the server
  var reasonSeq = 0;          // bumps on every restore or clear, so an older save does not clear a newer reason
  var historyBase = '/api/lines/' + LINE + '/history';

  var pendingSettings = null;       // newer remote settings held while the top fields have focus
  var pendingDisp = new Map();      // id -> newer remote disposition (or {deleted: ts}) held while its block has focus

  var blocks = new Map();           // disposition id -> block element
  var collapsed = loadCollapsed();
  var lastStamp = 0;

  // ---------- Small helpers ----------

  function $(id) { return document.getElementById(id); }

  function stamp() {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return lastStamp;
  }

  function uid() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var bytes = new Uint8Array(10);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = '';
    for (var j = 0; j < bytes.length; j++) out += chars[bytes[j] % chars.length];
    return out;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v !== 'string') return 0;
    var n = parseFloat(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function money0(v) { return Math.max(0, Math.round(num(v))); }

  function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }

  function dateStr(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }

  function toDays(v) {
    var n = Math.round(num(v));
    return DAYS.indexOf(n) >= 0 ? n : 90;
  }

  function group(digits) { return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function money(n) {
    var r = Math.round(n || 0);
    return (r < 0 ? '-$' : '$') + group(Math.abs(r));
  }

  function fmtNum(n) { return n ? group(Math.round(n)) : ''; }

  function pct(n) { return (Math.round(n * 100) / 100).toFixed(2) + '%'; }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function fmtDate(t) {
    var d = new Date(t);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }

  function fmtToday() {
    var d = new Date();
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtSaved(t) {
    var d = new Date(t);
    var h = d.getHours();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + h + ':' + pad(d.getMinutes()) + ' ' + ampm;
  }

  function fold(s) {
    s = String(s || '').toLowerCase();
    return s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
  }

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else e.setAttribute(k, v === true ? '' : v);
    });
    return e;
  }

  // ---------- Record model ----------

  function emptyRecord() {
    return {
      limit: 0,
      available: 0,
      tiie: 6.75,
      spread: 5,
      cushion: { amount: 0, note: '' },
      settingsUpdated: 0,
      dispositions: [],
      deleted: {}
    };
  }

  function emptyPayment() {
    return { id: uid(), name: '', amount: 0, risk: '', revenue: false, back: 0, backDate: '', toCredit: 0, paid: false };
  }

  function newDisposition() {
    var now = stamp();
    return {
      id: uid(), name: '', amount: 0, date: todayStr(), days: 90,
      created: now, updated: now, repaid: false, intPaid: {}, payments: [emptyPayment()]
    };
  }

  function normPayment(p, seen) {
    if (!isObject(p)) return null;
    var id = str(p.id);
    if (!id || seen[id]) id = uid();
    seen[id] = true;
    return {
      id: id,
      name: str(p.name),
      amount: money0(p.amount),
      risk: str(p.risk),
      revenue: !!p.revenue,
      back: money0(p.back),
      backDate: dateStr(p.backDate),
      toCredit: p.revenue ? money0(p.toCredit) : 0,
      paid: !!p.paid
    };
  }

  // Which monthly interest payments were made: keys "1".."N", true when paid.
  function normIntPaid(v, n) {
    var out = {};
    if (isObject(v)) {
      for (var k = 1; k <= n; k++) {
        if (v[k]) out[k] = true;
      }
    }
    return out;
  }

  function normDisposition(d) {
    if (!isObject(d)) return null;
    var seen = {};
    return {
      id: str(d.id),
      name: str(d.name),
      amount: money0(d.amount),
      date: dateStr(d.date),
      days: toDays(d.days),
      created: Math.max(0, num(d.created)),
      updated: Math.max(0, num(d.updated)),
      repaid: !!d.repaid,
      intPaid: normIntPaid(d.intPaid, toDays(d.days) / 30),
      payments: (Array.isArray(d.payments) ? d.payments : [])
        .map(function (p) { return normPayment(p, seen); })
        .filter(Boolean)
    };
  }

  // Coerce numbers, default missing fields, drop malformed items, prune old tombstones.
  function normalize(raw) {
    var r = isObject(raw) ? raw : {};
    var cushion = isObject(r.cushion) ? r.cushion : {};
    var out = {
      limit: money0(r.limit),
      available: money0(r.available),
      tiie: r.tiie === undefined || r.tiie === null || r.tiie === '' ? 6.75 : num(r.tiie),
      spread: r.spread === undefined || r.spread === null || r.spread === '' ? 5 : num(r.spread),
      cushion: { amount: money0(cushion.amount), note: str(cushion.note) },
      settingsUpdated: Math.max(0, num(r.settingsUpdated)),
      dispositions: [],
      deleted: {}
    };
    var ids = {};
    (Array.isArray(r.dispositions) ? r.dispositions : []).forEach(function (d) {
      var n = normDisposition(d);
      if (!n) return;
      if (!n.id) n.id = uid();
      if (ids[n.id]) return;
      ids[n.id] = true;
      out.dispositions.push(n);
    });
    var cutoff = Date.now() - TOMBSTONE_MS;
    var del = isObject(r.deleted) ? r.deleted : {};
    Object.keys(del).sort().forEach(function (id) {
      var t = num(del[id]);
      if (t > 0 && t >= cutoff) out.deleted[id] = t;
    });
    return out;
  }

  function validShape(data) {
    if (!isObject(data) || !Array.isArray(data.dispositions)) return false;
    if (data.cushion !== undefined && !isObject(data.cushion)) return false;
    if (data.deleted !== undefined && !isObject(data.deleted)) return false;
    return data.dispositions.every(function (d) {
      if (!isObject(d)) return false;
      if (d.payments === undefined) return true;
      return Array.isArray(d.payments) && d.payments.every(isObject);
    });
  }

  function pickSettings(r) {
    return {
      limit: r.limit, available: r.available, tiie: r.tiie, spread: r.spread,
      cushion: { amount: r.cushion.amount, note: r.cushion.note },
      settingsUpdated: r.settingsUpdated
    };
  }

  function assignSettings(target, src) {
    target.limit = src.limit;
    target.available = src.available;
    target.tiie = src.tiie;
    target.spread = src.spread;
    target.cushion = { amount: src.cushion.amount, note: src.cushion.note };
    target.settingsUpdated = src.settingsUpdated;
  }

  function findDisp(id) {
    for (var i = 0; i < record.dispositions.length; i++) {
      if (record.dispositions[i].id === id) return record.dispositions[i];
    }
    return null;
  }

  function dispName(d) {
    var i = record.dispositions.indexOf(d);
    return d.name.trim() || 'Disposition ' + (i + 1);
  }

  // ---------- Math ----------

  function annualRate(r) { return (r.tiie + r.spread) / 100; }

  function interestOf(amount, days, annual) { return amount * annual * days / 360; }

  function maturity(d) {
    var start = parseDate(d.date);
    if (start === null) start = parseDate(todayStr());
    return start + d.days * DAY_MS;
  }

  // The monthly payments of one disposition: interest every 30 days after the draw,
  // the principal together with the last one. They add up to the totals shown elsewhere.
  function paymentEvents(d, annual) {
    var n = Math.max(1, Math.round(d.days / 30));
    var start = parseDate(d.date);
    if (start === null) start = parseDate(todayStr());
    var monthly = interestOf(d.amount, 30, annual);
    var events = [];
    for (var k = 1; k <= n; k++) {
      events.push({
        d: d,
        k: k,
        n: n,
        date: start + k * 30 * DAY_MS,
        interest: monthly,
        amount: monthly + (k === n ? d.amount : 0),
        principal: k === n,
        paid: k === n ? d.repaid : !!d.intPaid[k]
      });
    }
    return events;
  }

  function allPaymentEvents(r, annual) {
    var events = [];
    r.dispositions.forEach(function (d, i) {
      if (d.amount <= 0) return;
      paymentEvents(d, annual).forEach(function (e) {
        e.order = i;
        events.push(e);
      });
    });
    events.sort(function (a, b) { return a.date - b.date || a.order - b.order || a.k - b.k; });
    return events;
  }

  // Money on its way back that is set aside for the credit, as dated inflows.
  function safeInflows(r) {
    var inflows = [];
    r.dispositions.forEach(function (d) {
      d.payments.forEach(function (p) {
        if (!p.revenue || p.toCredit <= 0) return;
        var t = parseDate(p.backDate);
        if (t === null) return;
        inflows.push({ date: t, amount: p.toCredit });
      });
    });
    inflows.sort(function (a, b) { return a.date - b.date; });
    return inflows;
  }

  // How much of each unpaid bank payment the safe covers, walking both lists by date.
  // Returns a Map from event to the covered amount.
  function safeCoverage(events, inflows) {
    var covered = new Map();
    var balance = 0;
    var i = 0;
    events.forEach(function (e) {
      if (e.paid) return;
      while (i < inflows.length && inflows[i].date <= e.date) {
        balance += inflows[i].amount;
        i++;
      }
      if (balance <= 0) return;
      var take = Math.min(balance, e.amount);
      covered.set(e, take);
      balance -= take;
    });
    return covered;
  }

  function nextPayment(r, annual) {
    var events = allPaymentEvents(r, annual);
    for (var i = 0; i < events.length; i++) {
      if (!events[i].paid) return events[i];
    }
    return null;
  }

  function totals(r) {
    var annual = annualRate(r);
    var t = {
      annual: annual, drawn: 0, interest: 0, revenue: 0, obligations: 0,
      back: 0, backCost: 0, hasBack: false, safe: 0, count: r.dispositions.length
    };
    r.dispositions.forEach(function (d) {
      t.drawn += d.amount;
      t.interest += interestOf(d.amount, d.days, annual);
      d.payments.forEach(function (p) {
        if (p.revenue) {
          t.revenue += p.amount;
          t.safe += p.toCredit;
          if (p.back > 0) {
            t.hasBack = true;
            t.back += p.back;
            t.backCost += p.amount + interestOf(p.amount, d.days, annual);
          }
        } else {
          t.obligations += p.amount;
        }
      });
    });
    t.left = r.available - r.cushion.amount - t.drawn;
    // What the bank already had out before this page: line total minus available today.
    t.used = r.limit > 0 ? Math.max(0, r.limit - r.available) : 0;
    return t;
  }

  // ---------- Status ----------

  function setStatus(text, isError) {
    var s = $('status');
    s.textContent = text;
    s.classList.toggle('bad', !!isError);
  }

  function isEmptyRecord(r) {
    return !r.dispositions.length && !r.limit && !r.available && !r.cushion.amount && !r.cushion.note;
  }

  // ---------- Collapsed state (per browser) ----------

  function loadCollapsed() {
    try {
      var v = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) || '{}');
      return isObject(v) ? v : {};
    } catch (_) {
      return {};
    }
  }

  function saveCollapsed() {
    var keep = {};
    record.dispositions.forEach(function (d) { if (collapsed[d.id]) keep[d.id] = true; });
    collapsed = keep;
    try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(keep)); } catch (_) { /* ignore */ }
  }

  // ---------- Money inputs ----------

  // Digits only, reformatted with thousands separators while typing. Returns the value in pesos.
  function reformatMoney(input) {
    var raw = input.value;
    var caret = raw.length;
    try { if (typeof input.selectionStart === 'number') caret = input.selectionStart; } catch (_) { /* ignore */ }
    var digitsBefore = raw.slice(0, caret).replace(/\D/g, '').length;
    var digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 15);
    var formatted = digits ? group(digits) : '';
    if (formatted !== raw) {
      input.value = formatted;
      var pos = 0;
      var seen = 0;
      while (pos < formatted.length && seen < digitsBefore) {
        if (/\d/.test(formatted.charAt(pos))) seen++;
        pos++;
      }
      try { if (document.activeElement === input) input.setSelectionRange(pos, pos); } catch (_) { /* ignore */ }
    }
    return digits ? parseInt(digits, 10) : 0;
  }

  function moneyInput(attrs, value) {
    return el('span', { class: 'money' }, [
      el('input', Object.assign({
        type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '0',
        'data-money': true, value: fmtNum(value)
      }, attrs))
    ]);
  }

  // ---------- Building disposition blocks ----------

  function field(label, control, cls) {
    return el('label', { class: 'field' + (cls ? ' ' + cls : '') }, [el('span', { class: 'label', text: label }), control]);
  }

  function cell(cls, label, control) {
    return el('label', { class: 'cell ' + cls }, [el('span', { class: 'label', text: label }), control]);
  }

  function buildPaymentRow(p) {
    return el('div', { class: 'pay' + (p.paid ? ' is-paid' : '') + (p.revenue ? ' is-rev' : ''), 'data-id': p.id }, [
      el('div', { class: 'pay-grid' }, [
        cell('c-paid', 'Paid', el('input', { type: 'checkbox', 'data-pf': 'paid', checked: p.paid })),
        cell('c-name', 'Payment', el('input', { type: 'text', 'data-pf': 'name', placeholder: 'Who or what', autocomplete: 'off', value: p.name })),
        cell('c-amount', 'Amount', moneyInput({ 'data-pf': 'amount' }, p.amount)),
        cell('c-risk', 'If we do not pay', el('input', { type: 'text', 'data-pf': 'risk', placeholder: 'What happens', autocomplete: 'off', value: p.risk })),
        cell('c-rev', 'Adds revenue', el('input', { type: 'checkbox', class: 'switch', role: 'switch', 'data-pf': 'revenue', checked: p.revenue })),
        cell('c-back rev-only', 'Brings back', moneyInput({ 'data-pf': 'back' }, p.back)),
        cell('c-safe rev-only', 'Set aside to repay the credit', moneyInput({ 'data-pf': 'toCredit' }, p.toCredit)),
        cell('c-backdate rev-only', 'Comes back on', el('input', { type: 'date', 'data-pf': 'backDate', value: p.backDate })),
        el('div', { class: 'cell c-remove' }, [
          el('button', { type: 'button', class: 'link quiet', 'data-act': 'remove-pay', text: 'Remove' })
        ])
      ]),
      el('p', { class: 'pay-calc' })
    ]);
  }

  function buildBlock(d) {
    var select = el('select', { 'data-f': 'days' }, DAYS.map(function (n) {
      return el('option', { value: String(n), text: n + ' days' });
    }));
    select.value = String(d.days);

    var head = el('div', { class: 'pay-head', 'aria-hidden': 'true' }, [
      'Paid', 'Payment', 'Amount', 'If we do not pay', 'Adds revenue', 'Brings back', 'To repay', 'Comes back on', ''
    ].map(function (t) { return el('span', { text: t }); }));

    var block = el('article', { class: 'disp', 'data-id': d.id }, [
      el('div', { class: 'disp-fields' }, [
        field('Name', el('input', { type: 'text', 'data-f': 'name', autocomplete: 'off', value: d.name }), 'grow'),
        field('Amount drawn', moneyInput({ 'data-f': 'amount' }, d.amount)),
        field('Drawn on', el('input', { type: 'date', 'data-f': 'date', value: d.date })),
        field('Repay in', select),
        el('div', { class: 'disp-remove' }, [
          el('button', { type: 'button', class: 'link quiet', 'data-act': 'remove-disp', text: 'Remove' })
        ])
      ]),
      el('p', { class: 'facts' }),
      el('div', { class: 'assign-bar' }, [el('span', { class: 'assign-fill' })]),
      el('p', { class: 'assign-note' }, [
        el('span', { class: 'assign-text' }),
        ' ',
        el('button', { type: 'button', class: 'link', 'data-act': 'toggle', text: 'Hide payments' })
      ]),
      el('div', { class: 'payments' }, [
        head,
        el('div', { class: 'pay-list' }, d.payments.map(buildPaymentRow)),
        el('button', { type: 'button', class: 'link', 'data-act': 'add-pay', text: '+ Add payment' })
      ])
    ]);
    return block;
  }

  function rebuildBlock(d) {
    var old = blocks.get(d.id);
    var fresh = buildBlock(d);
    if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
    blocks.set(d.id, fresh);
    applyView(fresh);
    return fresh;
  }

  // Insert missing blocks, remove stale ones, and put them in record order,
  // moving as few nodes as possible so focus is kept.
  function syncBlocks() {
    var container = $('dispositions');
    blocks.forEach(function (b, id) {
      if (!findDisp(id)) {
        if (b.parentNode) b.parentNode.removeChild(b);
        blocks.delete(id);
      }
    });
    var ref = container.firstElementChild;
    record.dispositions.forEach(function (d) {
      var b = blocks.get(d.id);
      if (!b) {
        b = buildBlock(d);
        blocks.set(d.id, b);
        applyView(b);
      }
      if (b === ref) ref = ref.nextElementSibling;
      else container.insertBefore(b, ref);
    });
  }

  // ---------- Refreshing computed text (never touches inputs) ----------

  function refreshBlock(d, index, annual) {
    var block = blocks.get(d.id);
    if (!block) return;
    block.querySelector('[data-f="name"]').setAttribute('placeholder', 'Disposition ' + (index + 1));

    var interest = interestOf(d.amount, d.days, annual);
    var events = paymentEvents(d, annual);
    var monthlyText = events.length === 1
      ? 'Interest is paid in one payment of ' + money(events[0].interest) + ' together with the principal.'
      : 'Interest is paid monthly: ' + events.length + ' payments of ' + money(events[0].interest) +
        ', the first on ' + fmtDate(events[0].date) + ', the last with the principal.';
    block.querySelector('.facts').textContent =
      'Back to ' + BANK + ' on ' + fmtDate(maturity(d)) + '. Interest ' + money(interest) +
      '. Total to pay ' + money(d.amount + interest) + '. ' + monthlyText;

    var assigned = 0;
    var paidCount = 0;
    var paidAmount = 0;
    d.payments.forEach(function (p) {
      assigned += p.amount;
      if (p.paid) { paidCount++; paidAmount += p.amount; }
    });
    var over = assigned > d.amount;
    var fill = block.querySelector('.assign-fill');
    fill.style.width = (d.amount > 0 ? Math.min(assigned / d.amount, 1) * 100 : (assigned > 0 ? 100 : 0)) + '%';
    block.querySelector('.assign-bar').classList.toggle('over', over);

    var rest = d.amount - assigned;
    var note;
    if (rest > 0) note = money(rest) + ' not yet assigned to a payment.';
    else if (rest < 0) note = 'Payments exceed the disposition by ' + money(-rest) + '.';
    else if (d.amount > 0) note = 'Fully assigned.';
    else note = 'Nothing drawn or assigned yet.';
    note += ' ' + plural(d.payments.length, 'payment', 'payments') + ', ' + paidCount + ' made (' + money(paidAmount) + ' paid).';
    var text = block.querySelector('.assign-text');
    text.textContent = note;
    text.classList.toggle('bad', over);

    var due = maturity(d);
    d.payments.forEach(function (p) {
      var row = block.querySelector('.pay[data-id="' + p.id + '"]');
      if (!row) return;
      row.classList.toggle('is-paid', p.paid);
      row.classList.toggle('is-rev', p.revenue);
      fillPayCalc(row.querySelector('.pay-calc'), p, d, annual, due);
    });
  }

  function fillPayCalc(target, p, d, annual, due) {
    var nodes = [];
    function text(s) { nodes.push(document.createTextNode(s)); }
    var cost = p.amount + interestOf(p.amount, d.days, annual);
    if (p.amount > 0) {
      text(money(p.amount) + ' paid with this credit really costs ' + money(cost) + ', ' +
        money(cost - p.amount) + ' of it interest.');
    }
    if (p.revenue && p.back > 0) {
      var backT = parseDate(p.backDate);
      text((nodes.length ? ' ' : '') + 'Brings back ' + money(p.back) + (backT !== null ? ' on ' + fmtDate(backT) : '') + ', ');
      var net = Math.round(p.back - cost);
      if (net >= 0) {
        text('net ');
        nodes.push(el('strong', { text: money(net) }));
        text(' after interest.');
      } else {
        nodes.push(el('span', { class: 'bad', text: 'short by ' + money(-net) + ' of its true cost.' }));
      }
    }
    if (p.revenue && p.toCredit > 0) {
      var sep2 = nodes.length ? ' ' : '';
      if (p.back > 0 && p.toCredit > p.back) {
        if (sep2) text(sep2);
        nodes.push(el('span', { class: 'bad', text: 'Set aside ' + money(p.toCredit) + ' is more than the ' + money(p.back) + ' that comes back.' }));
      } else {
        text(sep2 + money(p.toCredit) + ' of it is set aside to repay ' + BANK + '.');
      }
    }
    if (p.revenue && parseDate(p.backDate) !== null) {
      var diff = Math.round((due - parseDate(p.backDate)) / DAY_MS);
      var sep = nodes.length ? ' ' : '';
      if (diff > 0) text(sep + 'Arrives ' + plural(diff, 'day', 'days') + ' before ' + BANK + ' is due.');
      else if (diff < 0) {
        if (sep) text(sep);
        nodes.push(el('strong', { class: 'bad', text: 'Arrives ' + plural(-diff, 'day', 'days') + ' after ' + BANK + ' is due.' }));
      } else text(sep + 'Arrives the day ' + BANK + ' is due.');
    }
    if (p.paid) text((nodes.length ? ' ' : '') + 'Paid.');
    target.replaceChildren.apply(target, nodes);
  }

  function refreshAll() {
    var t = totals(record);
    var annual = t.annual;

    $('rate-sentence').textContent =
      'TIIE plus spread is ' + pct(annual * 100) + ' a year, ' + pct(annual * 100 / 12) + ' a month. ' +
      'A peso drawn for 90 days comes back as ' + (1 + annual * 90 / 360).toFixed(4) + ' pesos.';

    // Line total and what was already in use before this page
    var lineSentence = $('line-sentence');
    lineSentence.classList.remove('bad');
    if (record.limit > 0 && record.available > record.limit) {
      lineSentence.textContent = 'Available today (' + money(record.available) + ') is more than the line total (' +
        money(record.limit) + '). Check both numbers.';
      lineSentence.classList.add('bad');
    } else if (record.limit > 0) {
      lineSentence.textContent = 'Line total ' + money(record.limit) + '. ' + (t.used > 0
        ? money(t.used) + ' of it was already in use before this page, ' + money(record.available) + ' is available today.'
        : 'All of it is available today.');
    } else {
      lineSentence.textContent = 'Enter the line total to see how much was already in use before this page.';
    }

    // Allocation bar and legend (the whole line when its total is known)
    var base = Math.max(record.limit, t.used + record.available, t.used + record.cushion.amount + t.drawn, 1);
    var alloc = $('alloc');
    var segs = [];
    var legend = [];
    function seg(cls, amount) {
      var s = el('span', { class: 'seg ' + cls });
      s.style.width = (Math.max(amount, 0) / base * 100) + '%';
      segs.push(s);
    }
    function key(cls, label) {
      legend.push(el('li', {}, [el('span', { class: 'swatch ' + cls }), label]));
    }
    if (t.used > 0) {
      seg('seg-used', t.used);
      key('seg-used', 'Already in use ' + money(t.used));
    }
    seg('seg-cushion', record.cushion.amount);
    key('seg-cushion', 'Cushion ' + money(record.cushion.amount));
    record.dispositions.forEach(function (d, i) {
      var cls = i % 2 ? 'seg-b' : 'seg-a';
      seg(cls, d.amount);
      key(cls, dispName(d) + ' ' + money(d.amount));
    });
    key('seg-free', 'Available ' + money(t.left));
    alloc.replaceChildren.apply(alloc, segs);
    var legendEl = $('legend');
    legendEl.replaceChildren.apply(legendEl, legend);

    // Big numbers
    $('big-safe').textContent = money(t.safe);
    $('big-cushion').textContent = money(record.cushion.amount);
    $('big-drawn').textContent = money(t.drawn);
    $('big-drawn-label').textContent = 'drawn from ' + BANK + ' in ' + plural(t.count, 'disposition', 'dispositions');
    $('big-left').textContent = money(t.left);
    $('big-left').classList.toggle('bad', t.left < 0);
    var over = $('over');
    if (t.left < 0) {
      over.textContent = 'Over the available line by ' + money(-t.left) + '.';
      over.hidden = false;
    } else {
      over.textContent = '';
      over.hidden = true;
    }

    // Cost sentence
    $('cost-sentence').textContent = t.drawn > 0
      ? 'Paying ' + BANK + ' back will cost ' + money(t.interest) + ' in interest. The ' + money(t.drawn) +
        ' we draw becomes ' + money(t.drawn + t.interest) + ' by the time it is repaid.'
      : 'Nothing drawn yet. Every peso drawn costs ' + pct(annual * 100 / 12) + ' a month until it is paid back.';

    // Split sentence
    var split = $('split-sentence');
    var assigned = t.revenue + t.obligations;
    var parts = [];
    if (assigned > 0) {
      parts.push(document.createTextNode(
        'Of what is assigned, ' + money(t.revenue) + ' (' + Math.round(t.revenue / assigned * 100) + '%) goes to things that add revenue and ' +
        money(t.obligations) + ' to obligations.'
      ));
    } else {
      parts.push(document.createTextNode('Nothing is assigned to a payment yet.'));
    }
    if (t.hasBack) {
      var diff = Math.round(t.back - t.backCost);
      parts.push(document.createTextNode(' The revenue payments are expected to bring back '));
      parts.push(el('span', { class: 'gold', text: money(t.back) }));
      parts.push(document.createTextNode(', ' + money(Math.abs(diff)) + (diff >= 0 ? ' more' : ' less') + ' than they cost with interest.'));
    }
    if (t.safe > 0) {
      parts.push(document.createTextNode(' Of what comes back, ' + money(t.safe) + ' is set aside to repay the credit.'));
    }
    split.replaceChildren.apply(split, parts);

    renderMonthAhead(annual);
    record.dispositions.forEach(function (d, i) { refreshBlock(d, i, annual); });
    renderSchedule(annual);
    refreshWhatIf();
  }

  // What the next 30 days look like: payments to the bank and money coming back.
  function renderMonthAhead(annual) {
    var today = parseDate(todayStr());
    var until = today + 30 * DAY_MS;
    var payTotal = 0;
    var payCount = 0;
    allPaymentEvents(record, annual).forEach(function (e) {
      if (e.paid || e.date < today || e.date > until) return;
      payTotal += e.amount;
      payCount++;
    });
    var backTotal = 0;
    var safeTotal = 0;
    record.dispositions.forEach(function (d) {
      d.payments.forEach(function (p) {
        if (!p.revenue || p.back <= 0) return;
        var t = parseDate(p.backDate);
        if (t === null || t < today || t > until) return;
        backTotal += p.back;
        safeTotal += Math.min(p.toCredit, p.back);
      });
    });
    var sentence;
    if (payTotal > 0) {
      sentence = 'In the next 30 days we pay ' + money(payTotal) + ' to ' + BANK + ' in ' +
        plural(payCount, 'payment', 'payments');
      sentence += backTotal > 0
        ? ' and expect ' + money(backTotal) + ' back' +
          (safeTotal > 0 ? ', ' + money(safeTotal) + ' of it set aside for the credit.' : '.')
        : ' and expect no money back.';
    } else if (backTotal > 0) {
      sentence = 'In the next 30 days there are no payments to ' + BANK + ', and we expect ' + money(backTotal) +
        ' back' + (safeTotal > 0 ? ', ' + money(safeTotal) + ' of it set aside for the credit.' : '.');
    } else {
      sentence = 'In the next 30 days there are no payments to ' + BANK + ' and no money coming back.';
    }
    $('month-sentence').textContent = sentence;
  }

  // ---------- Try a draw (never saved) ----------

  function whatIfValues() {
    return { amount: money0(($('whatif-amount').value || '').replace(/,/g, '')), days: toDays($('whatif-days').value) };
  }

  function refreshWhatIf() {
    var v = whatIfValues();
    var out = $('whatif-result');
    var t = totals(record);
    out.classList.remove('bad');
    if (v.amount <= 0) {
      out.textContent = 'Type an amount to see what it would cost before drawing it.';
      out.className = 'muted whatif-result';
      return;
    }
    out.className = 'whatif-result';
    var annual = t.annual;
    var n = v.days / 30;
    var interest = interestOf(v.amount, v.days, annual);
    var monthly = interestOf(v.amount, 30, annual);
    var due = parseDate(todayStr()) + v.days * DAY_MS;
    var after = t.left - v.amount;
    var textOut = 'Drawing ' + money(v.amount) + ' for ' + v.days + ' days costs ' + money(interest) + ' in interest: ' +
      (n === 1 ? 'one payment of ' + money(monthly) + ' with the principal on ' + fmtDate(due)
        : n + ' monthly payments of ' + money(monthly) + ', and the principal back on ' + fmtDate(due)) +
      '. Total ' + money(v.amount + interest) + '. Still available would go from ' + money(t.left) +
      ' to ' + money(after) + '.';
    out.textContent = textOut;
    if (after < 0) {
      out.appendChild(document.createTextNode(' '));
      out.appendChild(el('strong', { class: 'bad', text: 'That is ' + money(-after) + ' over the line.' }));
    }
  }

  function addWhatIf() {
    if (!loaded) return;
    var v = whatIfValues();
    if (v.amount <= 0) {
      $('whatif-amount').focus();
      return;
    }
    var d = newDisposition();
    d.amount = v.amount;
    d.days = v.days;
    record.dispositions.push(d);
    syncBlocks();
    $('whatif-amount').value = '';
    markDirty();
    refreshAll();
    blocks.get(d.id).querySelector('[data-f="name"]').focus();
  }

  function renderSettings() {
    $('limit').value = fmtNum(record.limit);
    $('available').value = fmtNum(record.available);
    $('tiie').value = String(record.tiie);
    $('spread').value = String(record.spread);
    $('cushion-amount').value = fmtNum(record.cushion.amount);
    $('cushion-note').value = record.cushion.note;
  }

  function renderAllBlocks() {
    var container = $('dispositions');
    container.replaceChildren();
    blocks.clear();
    syncBlocks();
  }

  // ---------- Schedule ----------

  function renderSchedule(annual) {
    var wrap = $('schedule');
    var active = document.activeElement;
    var focusKey = active && wrap.contains(active) && active.getAttribute('data-id')
      ? active.getAttribute('data-id') + ':' + active.getAttribute('data-k')
      : null;

    var events = allPaymentEvents(record, annual);
    if (!events.length) {
      wrap.replaceChildren(el('p', { class: 'muted', text: 'Nothing to pay yet.' }));
      return;
    }

    var today = parseDate(todayStr());
    var covered = safeCoverage(events, safeInflows(record));
    var total = 0;
    var repaid = 0;
    var next = null;
    var lateCount = 0;
    var lateTotal = 0;
    events.forEach(function (e) {
      total += e.amount;
      if (e.paid) repaid += e.amount;
      else {
        if (!next) next = e;
        if (e.date < today) {
          e.late = true;
          lateCount++;
          lateTotal += e.amount;
        }
      }
    });

    var rows = events.map(function (e) {
      var what = e.principal
        ? (e.n === 1 ? 'Principal + interest' : 'Principal + last interest')
        : 'Monthly interest ' + e.k + ' of ' + e.n;
      var cls = (e.paid ? 'is-paid' : '') + (e === next ? ' is-next' : '') + (e.late ? ' is-late' : '');
      var cover = covered.get(e) || 0;
      var whatCell = el('td', { class: e.principal ? '' : 'muted' }, [what]);
      if (cover > 0) {
        whatCell.appendChild(el('span', { class: 'covered', text: cover >= e.amount
          ? 'Covered by the safe'
          : 'Partly covered by the safe (' + money(cover) + ')' }));
      }
      return el('tr', { class: cls.trim() }, [
        el('td', { text: fmtDate(e.date) }),
        el('td', { text: dispName(e.d) }),
        whatCell,
        el('td', { class: 'num', text: money(e.amount) }),
        el('td', { class: 'check' }, [
          el('input', {
            type: 'checkbox', 'data-id': e.d.id, 'data-k': String(e.k), checked: e.paid,
            'aria-label': 'Paid ' + what + ', ' + dispName(e.d)
          })
        ])
      ]);
    });

    var table = el('table', { class: 'schedule' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Date' }), el('th', { text: 'Disposition' }), el('th', { text: 'Payment' }),
        el('th', { class: 'num', text: 'Amount' }), el('th', { class: 'check', text: 'Paid' })
      ])]),
      el('tbody', {}, rows),
      el('tfoot', {}, [el('tr', {}, [
        el('td', { text: 'Total' }), el('td'), el('td'),
        el('td', { class: 'num', text: money(total) }),
        el('td')
      ])])
    ]);

    var safe = totals(record).safe;
    var still = total - repaid;
    var parts = [
      el('div', { class: 'table-scroll' }, [table]),
      el('p', { class: 'muted schedule-note', text: 'Repaid so far ' + money(repaid) + '. Still to pay ' + money(still) + '.' })
    ];
    if (safe > 0 && still > 0) {
      parts.push(el('p', { class: 'muted safe-note', text:
        'The repayment safe holds ' + money(safe) + ' of money on its way back: it covers ' +
        Math.min(100, Math.round(safe / still * 100)) + '% of the ' + money(still) + ' still to pay.' }));
    }
    if (lateCount > 0) {
      parts.push(el('p', { class: 'overdue-note', text:
        plural(lateCount, 'payment is', 'payments are') + ' overdue: ' + money(lateTotal) + '.' }));
    }
    parts.push(next ? el('p', { class: 'next-payment' + (next.late ? ' bad' : '') }, next.late ? [
      'Overdue: ',
      el('strong', { text: money(next.amount) + ' to ' + BANK + ' was due on ' + fmtDate(next.date) }),
      ' (' + dispName(next.d) + ').'
    ] : [
      'Next payment to ' + BANK + ': ',
      el('strong', { text: money(next.amount) + ' on ' + fmtDate(next.date) }),
      ' (' + dispName(next.d) + ').'
    ]) : el('p', { class: 'next-payment', text: 'Everything is paid back. Nothing pending.' }));
    wrap.replaceChildren.apply(wrap, parts);

    if (focusKey) {
      var parts = focusKey.split(':');
      var again = wrap.querySelector('input[data-id="' + parts[0] + '"][data-k="' + parts[1] + '"]');
      if (again) again.focus();
    }
  }

  // ---------- Search and show / hide ----------

  function searchQuery() { return fold($('search').value.trim()); }

  function applyView(block) {
    var d = findDisp(block.getAttribute('data-id'));
    if (!d) return 0;
    var q = searchQuery();
    var rows = block.querySelectorAll('.pay');
    var toggle = block.querySelector('[data-act="toggle"]');
    if (!q) {
      block.hidden = false;
      rows.forEach(function (r) { r.hidden = false; });
      var isCollapsed = !!collapsed[d.id];
      block.classList.toggle('collapsed', isCollapsed);
      toggle.textContent = isCollapsed ? 'Show payments' : 'Hide payments';
      return 0;
    }
    var matches = 0;
    rows.forEach(function (r) {
      var p = null;
      for (var i = 0; i < d.payments.length; i++) if (d.payments[i].id === r.getAttribute('data-id')) p = d.payments[i];
      var hit = !!p && (fold(p.name).indexOf(q) >= 0 || fold(p.risk).indexOf(q) >= 0);
      r.hidden = !hit;
      if (hit) matches++;
    });
    block.hidden = matches === 0;
    block.classList.remove('collapsed');
    toggle.textContent = 'Hide payments';
    return matches;
  }

  function applySearch() {
    var total = 0;
    blocks.forEach(function (b) { total += applyView(b); });
    $('search-count').textContent = searchQuery()
      ? (total === 1 ? '1 payment matches' : total + ' payments match')
      : '';
  }

  // ---------- Editing ----------

  function markDirty() {
    dirty = true;
    setStatus('Saving.');
    scheduleSave(SAVE_DELAY);
  }

  function touchSettings() {
    record.settingsUpdated = stamp();
    markDirty();
    refreshAll();
  }

  function touchDisp(d) {
    d.updated = stamp();
    markDirty();
    refreshAll();
  }

  function onSettingsEdit(e) {
    if (!loaded) return;
    var t = e.target;
    var before = JSON.stringify(pickSettings(record));
    switch (t.id) {
      case 'limit': record.limit = reformatMoney(t); break;
      case 'available': record.available = reformatMoney(t); break;
      case 'tiie': record.tiie = num(t.value); break;
      case 'spread': record.spread = num(t.value); break;
      case 'cushion-amount': record.cushion.amount = reformatMoney(t); break;
      case 'cushion-note': record.cushion.note = t.value; break;
      default: return;
    }
    if (JSON.stringify(pickSettings(record)) !== before) touchSettings();
  }

  function onDispEdit(e) {
    if (!loaded) return;
    var t = e.target;
    var block = t.closest('.disp');
    if (!block) return;
    var d = findDisp(block.getAttribute('data-id'));
    if (!d) return;
    var f = t.getAttribute('data-f');
    var pf = t.getAttribute('data-pf');
    var before = JSON.stringify(d);

    if (f) {
      if (f === 'name') d.name = t.value;
      else if (f === 'amount') d.amount = reformatMoney(t);
      else if (f === 'date') d.date = dateStr(t.value);
      else if (f === 'days') d.days = toDays(t.value);
      else return;
    } else if (pf) {
      var row = t.closest('.pay');
      var p = null;
      for (var i = 0; i < d.payments.length; i++) if (d.payments[i].id === row.getAttribute('data-id')) p = d.payments[i];
      if (!p) return;
      if (pf === 'name') p.name = t.value;
      else if (pf === 'amount') p.amount = reformatMoney(t);
      else if (pf === 'risk') p.risk = t.value;
      else if (pf === 'revenue') p.revenue = t.checked;
      else if (pf === 'back') p.back = reformatMoney(t);
      else if (pf === 'toCredit') p.toCredit = reformatMoney(t);
      else if (pf === 'backDate') p.backDate = dateStr(t.value);
      else if (pf === 'paid') p.paid = t.checked;
      else return;
    } else {
      return;
    }
    if (JSON.stringify(d) !== before) touchDisp(d);
  }

  function onDispClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || !loaded) return;
    var block = btn.closest('.disp');
    var d = block && findDisp(block.getAttribute('data-id'));
    if (!d) return;
    var act = btn.getAttribute('data-act');

    if (act === 'toggle') {
      if (collapsed[d.id]) delete collapsed[d.id];
      else collapsed[d.id] = true;
      saveCollapsed();
      applyView(block);
    } else if (act === 'add-pay') {
      var p = emptyPayment();
      d.payments.push(p);
      var row = buildPaymentRow(p);
      block.querySelector('.pay-list').appendChild(row);
      touchDisp(d);
      row.querySelector('[data-pf="name"]').focus();
    } else if (act === 'remove-pay') {
      var rowEl = btn.closest('.pay');
      var pid = rowEl.getAttribute('data-id');
      d.payments = d.payments.filter(function (x) { return x.id !== pid; });
      rowEl.parentNode.removeChild(rowEl);
      touchDisp(d);
    } else if (act === 'remove-disp') {
      if (!window.confirm('Remove ' + dispName(d) + ' and its payments?')) return;
      removeDisposition(d.id, stamp());
      markDirty();
      refreshAll();
    }
  }

  function removeDisposition(id, when) {
    record.deleted[id] = Math.max(record.deleted[id] || 0, when);
    record.dispositions = record.dispositions.filter(function (x) { return x.id !== id; });
    pendingDisp.delete(id);
    var b = blocks.get(id);
    if (b && b.parentNode) b.parentNode.removeChild(b);
    blocks.delete(id);
  }

  function addDisposition() {
    if (!loaded) return;
    var d = newDisposition();
    record.dispositions.push(d);
    syncBlocks();
    markDirty();
    refreshAll();
    var name = blocks.get(d.id).querySelector('[data-f="name"]');
    name.focus();
  }

  function onScheduleChange(e) {
    var t = e.target;
    if (!loaded || t.type !== 'checkbox') return;
    var d = findDisp(t.getAttribute('data-id'));
    if (!d) return;
    var k = Math.round(num(t.getAttribute('data-k')));
    var n = Math.max(1, Math.round(d.days / 30));
    if (k === n) {
      if (d.repaid === t.checked) return;
      d.repaid = t.checked;
    } else {
      if (!!d.intPaid[k] === t.checked) return;
      if (t.checked) d.intPaid[k] = true;
      else delete d.intPaid[k];
    }
    touchDisp(d);
  }

  // ---------- Merging ----------

  function currentFocus() {
    var a = document.activeElement;
    var f = { settings: false, dispId: null };
    if (!a || a === document.body || !a.closest) return f;
    if (a.closest('[data-settings]')) f.settings = true;
    var b = a.closest('.disp');
    if (b) f.dispId = b.getAttribute('data-id');
    return f;
  }

  // What we send: the local record, except that a newer remote copy held aside
  // (because someone is typing in that block) is carried so nothing newer is overwritten.
  function buildPayload() {
    var data = clone(record);
    if (pendingSettings && pendingSettings.settingsUpdated > data.settingsUpdated) assignSettings(data, pendingSettings);
    pendingDisp.forEach(function (rd, id) {
      for (var i = 0; i < data.dispositions.length; i++) {
        if (data.dispositions[i].id !== id) continue;
        if (rd.deletedAt) {
          if (rd.deletedAt >= data.dispositions[i].updated) data.dispositions.splice(i, 1);
        } else if (rd.updated > data.dispositions[i].updated) {
          data.dispositions[i] = clone(rd);
        }
        return;
      }
    });
    return normalize(data);
  }

  // Merge an incoming record into the local one. Returns true when the server
  // copy lacks something local and a save is needed.
  function applyRemote(raw) {
    var remote = normalize(raw);
    var local = record;
    var focus = currentFocus();

    var deleted = {};
    [local.deleted, remote.deleted].forEach(function (src) {
      Object.keys(src).forEach(function (id) { deleted[id] = Math.max(deleted[id] || 0, src[id]); });
    });

    var next = {
      limit: local.limit, available: local.available, tiie: local.tiie, spread: local.spread,
      cushion: { amount: local.cushion.amount, note: local.cushion.note },
      settingsUpdated: local.settingsUpdated,
      dispositions: [],
      deleted: deleted
    };

    var settingsChanged = false;
    if (remote.settingsUpdated > local.settingsUpdated) {
      if (focus.settings) {
        pendingSettings = pickSettings(remote);
      } else {
        assignSettings(next, remote);
        pendingSettings = null;
        settingsChanged = true;
      }
    }

    var localById = {};
    var remoteById = {};
    local.dispositions.forEach(function (d) { localById[d.id] = d; });
    remote.dispositions.forEach(function (d) { remoteById[d.id] = d; });

    var changed = [];
    remote.dispositions.forEach(function (rd) {
      var ld = localById[rd.id];
      if (ld) {
        if (rd.updated > ld.updated) {
          if (focus.dispId === rd.id) {
            pendingDisp.set(rd.id, rd);
            next.dispositions.push(ld);
          } else {
            pendingDisp.delete(rd.id);
            next.dispositions.push(rd);
            changed.push(rd.id);
          }
        } else {
          next.dispositions.push(ld);
        }
      } else {
        var tomb = local.deleted[rd.id];
        if (tomb && tomb >= rd.updated) return;
        next.dispositions.push(rd);
        changed.push(rd.id);
      }
    });

    local.dispositions.forEach(function (ld, i) {
      if (remoteById[ld.id]) return;
      var tomb = remote.deleted[ld.id];
      if (tomb && tomb >= ld.updated) {
        if (focus.dispId !== ld.id) {
          pendingDisp.delete(ld.id);
          return;
        }
        pendingDisp.set(ld.id, { deletedAt: tomb });
      }
      // Keep it, right after its nearest local predecessor that survived.
      var at = 0;
      for (var j = i - 1; j >= 0; j--) {
        var k = next.dispositions.indexOf(local.dispositions[j]);
        if (k >= 0) { at = k + 1; break; }
      }
      next.dispositions.splice(at, 0, ld);
    });

    record = next;

    changed.forEach(function (id) {
      if (blocks.has(id)) rebuildBlock(findDisp(id));
    });
    syncBlocks();
    if (settingsChanged) renderSettings();
    if (searchQuery()) applySearch();
    refreshAll();

    return JSON.stringify(buildPayload()) !== JSON.stringify(normalize(remote));
  }

  // When focus leaves a block, apply the newer remote copy held aside for it.
  function applyHeld() {
    if (!loaded) return;
    var focus = currentFocus();
    var touched = false;

    if (pendingSettings && !focus.settings) {
      if (pendingSettings.settingsUpdated > record.settingsUpdated) {
        assignSettings(record, pendingSettings);
        renderSettings();
      }
      pendingSettings = null;
      touched = true;
    }

    Array.from(pendingDisp.keys()).forEach(function (id) {
      if (focus.dispId === id) return;
      var rd = pendingDisp.get(id);
      pendingDisp.delete(id);
      touched = true;
      var d = findDisp(id);
      if (!d) return;
      if (rd.deletedAt) {
        if (rd.deletedAt >= d.updated) removeDisposition(id, rd.deletedAt);
      } else if (rd.updated > d.updated) {
        var idx = record.dispositions.indexOf(d);
        record.dispositions[idx] = rd;
        rebuildBlock(rd);
      }
    });

    if (touched) refreshAll();
  }

  // ---------- Saving ----------

  function scheduleSave(delay) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      flush();
    }, delay);
  }

  function toLogin() {
    window.location.href = '/login?next=' + encodeURIComponent('/' + LINE);
  }

  function flush() {
    if (inFlight) return;          // the running save picks up the queued edits when it finishes
    if (!dirty) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    dirty = false;
    inFlight = true;

    var payload = buildPayload();
    var sentReason = pendingReason;
    var sentSeq = reasonSeq;
    fetch(RECORD_URL, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(sentReason
        ? { baseVersion: version, data: payload, reason: sentReason }
        : { baseVersion: version, data: payload })
    }).then(function (res) {
      if (res.status === 401) {
        inFlight = false;
        toLogin();
        return;
      }
      if (res.status === 409) {
        return res.json().then(function (j) {
          version = j.version;
          var needs = applyRemote(j.data);
          inFlight = false;
          if (needs || dirty) {
            dirty = true;
            flush();
          } else {
            afterSaved();
          }
        });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().then(function (j) {
        version = j.version;
        inFlight = false;
        if (sentReason && reasonSeq === sentSeq) pendingReason = '';
        if (j.snapshot) scheduleHistory();
        afterSaved();
      });
    }).catch(function () {
      inFlight = false;
      dirty = true;
      setStatus('Not saved yet. No connection to the record, retrying.', true);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(function () {
        retryTimer = null;
        flush();
      }, RETRY_DELAY);
    });
  }

  function afterSaved() {
    if (dirty) {
      if (!saveTimer) flush();
      return;
    }
    if (!saveTimer) setStatus('Saved ' + fmtSaved(Date.now()) + '. Everyone with the code sees this.');
    if (missedChange) {
      missedChange = false;
      pull();
    }
  }

  // ---------- Loading and live updates ----------

  function getRecord() {
    return fetch(RECORD_URL, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (res) {
      if (res.status === 401) {
        toLogin();
        return null;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function pull() {
    if (!loaded || pulling) return Promise.resolve();
    if (inFlight) {
      missedChange = true;
      return Promise.resolve();
    }
    pulling = true;
    return getRecord().then(function (j) {
      if (!j) return;
      if (inFlight) {
        missedChange = true;
        return;
      }
      if (!(j.version > version)) return;
      version = j.version;
      if (applyRemote(j.data)) {
        dirty = true;
        if (!saveTimer) flush();
      }
      scheduleHistory();
    }).catch(function () { /* the next pull retries */ }).then(function () {
      pulling = false;
    });
  }

  function connectLive() {
    if (typeof window.EventSource === 'function') {
      var source = new window.EventSource('/api/events');
      source.addEventListener('changed', function (e) {
        var v;
        try {
          var msg = JSON.parse(e.data);
          if (msg.line && msg.line !== LINE) return;
          v = msg.version;
        } catch (_) { return; }
        if (v === version) return;
        if (inFlight) {
          missedChange = true;
          return;
        }
        pull();
      });
      setInterval(pull, PULL_MS);
    } else {
      setInterval(pull, POLL_MS);
    }
  }

  function load() {
    getRecord().then(function (j) {
      if (!j) return;
      version = Number(j.version) || 0;
      record = normalize(j.data);
      loaded = true;
      renderSettings();
      renderAllBlocks();
      refreshAll();
      setStatus(isEmptyRecord(record)
        ? 'Empty record. Changes save automatically.'
        : 'Record loaded. Changes save automatically.');
      connectLive();
      loadHistory(false);
    }).catch(function () {
      setStatus('Could not load the record. Retrying.', true);
      setTimeout(load, RETRY_DELAY);
    });
  }

  // ---------- Replace (restore and clear) ----------

  function replaceRecord(data, reason) {
    var now = stamp();
    var next = normalize(data);
    var keep = {};
    next.dispositions.forEach(function (d) { keep[d.id] = true; });

    var deleted = {};
    [record.deleted, next.deleted].forEach(function (src) {
      Object.keys(src).forEach(function (id) { deleted[id] = Math.max(deleted[id] || 0, src[id]); });
    });
    record.dispositions.forEach(function (d) { if (!keep[d.id]) deleted[d.id] = now; });
    next.dispositions.forEach(function (d) {
      d.updated = now;
      if (!d.created) d.created = now;
      delete deleted[d.id];
    });
    next.settingsUpdated = now;
    next.deleted = deleted;

    pendingSettings = null;
    pendingDisp.clear();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    record = normalize(next);
    renderSettings();
    renderAllBlocks();
    if (searchQuery()) applySearch();
    refreshAll();
    pendingReason = reason || 'restore';
    reasonSeq++;
    markDirty();
  }

  // ---------- Summary ----------

  // Plain text summary of the current record or of a saved version.
  function buildSummary(r, when) {
    r = r || record;
    var t = totals(r);
    var annual = t.annual;
    var lines = [];
    lines.push('AROMARIA, ' + BANK + ' line, ' + (when || fmtToday()));
    if (r.limit > 0) {
      lines.push('Line total ' + money(r.limit) + '. Already in use before this page ' + money(t.used) + '.');
    }
    lines.push(
      'Available today ' + money(r.available) + '. Cushion ' + money(r.cushion.amount) +
      (r.cushion.note.trim() ? ' (' + r.cushion.note.trim() + ')' : '') + '. Drawn ' + money(t.drawn) +
      ' in ' + plural(t.count, 'disposition', 'dispositions') + '. Still available ' + money(t.left) + '.' +
      (t.left < 0 ? ' Over the available line by ' + money(-t.left) + '.' : '')
    );
    lines.push(
      'TIIE ' + r.tiie + '% plus spread ' + r.spread + '%, ' + pct(annual * 100) + ' a year, ' +
      pct(annual * 100 / 12) + ' a month. Interest to ' + BANK + ' ' + money(t.interest) + ', paid monthly. Total to repay ' +
      money(t.drawn + t.interest) + '.'
    );
    var coming = nextPayment(r, annual);
    if (coming) {
      lines.push('Next payment to ' + BANK + ': ' + money(coming.amount) + ' on ' + fmtDate(coming.date) + '.');
    }
    if (t.safe > 0) {
      var owed = 0;
      allPaymentEvents(r, annual).forEach(function (e) { if (!e.paid) owed += e.amount; });
      lines.push('Repayment safe: ' + money(t.safe) + ' of what comes back is set aside for the credit' +
        (owed > 0 ? ', covering ' + Math.min(100, Math.round(t.safe / owed * 100)) + '% of the ' + money(owed) + ' still to pay.' : '.'));
    }
    var assigned = t.revenue + t.obligations;
    if (assigned > 0) {
      var s = 'Of what is assigned, ' + money(t.revenue) + ' (' + Math.round(t.revenue / assigned * 100) +
        '%) goes to things that add revenue and ' + money(t.obligations) + ' to obligations.';
      if (t.hasBack) {
        var diff = Math.round(t.back - t.backCost);
        s += ' The revenue payments are expected to bring back ' + money(t.back) + ', ' + money(Math.abs(diff)) +
          (diff >= 0 ? ' more' : ' less') + ' than they cost with interest.';
      }
      lines.push(s);
    }

    r.dispositions.forEach(function (d) {
      var interest = interestOf(d.amount, d.days, annual);
      var due = maturity(d);
      var drawnOn = parseDate(d.date);
      lines.push('');
      lines.push(
        (d.name.trim() || 'Disposition ' + (r.dispositions.indexOf(d) + 1)) + ', ' + money(d.amount) + ' drawn' + (drawnOn !== null ? ' on ' + fmtDate(drawnOn) : '') +
        ' for ' + d.days + ' days. Back to ' + BANK + ' on ' + fmtDate(due) + '. Interest ' + money(interest) +
        '. Total to pay ' + money(d.amount + interest) + '.' + (d.repaid ? ' Repaid.' : '')
      );
      var ev = paymentEvents(d, annual);
      lines.push(ev.length === 1
        ? 'Interest in one payment of ' + money(ev[0].interest) + ' with the principal on ' + fmtDate(ev[0].date) + '.'
        : 'Interest paid monthly: ' + ev.length + ' payments of ' + money(ev[0].interest) + ', the first on ' +
          fmtDate(ev[0].date) + ', the last with the principal on ' + fmtDate(ev[ev.length - 1].date) + '.');
      if (!d.payments.length) lines.push('No payments yet.');
      d.payments.forEach(function (p, i) {
        var cost = p.amount + interestOf(p.amount, d.days, annual);
        var line = (i + 1) + '. ' + (p.name.trim() || 'Unnamed payment') + ', ' + money(p.amount) +
          ', really costs ' + money(cost) + '.';
        if (p.revenue) {
          line += ' Adds revenue.';
          var backT = parseDate(p.backDate);
          if (p.back > 0) {
            var net = Math.round(p.back - cost);
            line += ' Brings back ' + money(p.back) + (backT !== null ? ' on ' + fmtDate(backT) : '') + ', ' +
              (net >= 0 ? 'net ' + money(net) + ' after interest.' : 'short by ' + money(-net) + ' of its true cost.');
          }
          if (p.toCredit > 0) line += ' ' + money(p.toCredit) + ' of it set aside to repay.';
          if (backT !== null) {
            var days = Math.round((due - backT) / DAY_MS);
            line += days > 0 ? ' Arrives ' + plural(days, 'day', 'days') + ' before ' + BANK + ' is due.'
              : days < 0 ? ' Arrives ' + plural(-days, 'day', 'days') + ' after ' + BANK + ' is due.'
                : ' Arrives the day ' + BANK + ' is due.';
          }
        } else {
          line += ' Obligation.';
        }
        if (p.paid) line += ' Paid.';
        var risk = p.risk.trim();
        if (risk) line += ' If we do not pay: ' + risk + (/[.!?]$/.test(risk) ? '' : '.');
        lines.push(line);
      });
    });
    return lines.join('\n');
  }

  // ---------- Saved versions (history kept by the server) ----------

  var HISTORY_PAGE = 10;
  var REASONS = {
    '': 'Regular copy',
    removal: 'Before something was removed',
    restore: 'Before a restore',
    clear: 'Before starting over'
  };
  var historyEntries = [];
  var historyMore = false;
  var historyTimer = null;
  var historyLoading = false;

  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (res) {
      if (res.status === 401) {
        toLogin();
        return null;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function scheduleHistory() {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(function () {
      historyTimer = null;
      loadHistory(false);
    }, 1200);
  }

  function loadHistory(older) {
    if (historyLoading) return Promise.resolve();
    historyLoading = true;
    var limit = older ? HISTORY_PAGE : Math.min(100, Math.max(HISTORY_PAGE, historyEntries.length));
    var url = historyBase + '?limit=' + limit;
    if (older && historyEntries.length) url += '&before=' + historyEntries[historyEntries.length - 1].hid;
    return getJSON(url).then(function (j) {
      if (!j) return;
      historyEntries = older ? historyEntries.concat(j.entries) : j.entries;
      historyMore = !!j.more;
      renderHistory();
    }).catch(function () {
      if (!historyEntries.length) {
        $('history').replaceChildren(el('p', { class: 'muted', text: 'Saved versions could not be loaded right now. They are still kept on the server.' }));
      }
    }).then(function () {
      historyLoading = false;
    });
  }

  function fmtWhen(e) {
    var t = e.savedAt || e.createdAt;
    var label = fmtSaved(t);
    var d = new Date(t);
    return d.getFullYear() === new Date().getFullYear() ? label : label.replace(',', ' ' + d.getFullYear() + ',');
  }

  function describe(sum) {
    sum = sum || {};
    return plural(sum.count || 0, 'disposition', 'dispositions') + ', ' + money(sum.drawn || 0) + ' drawn, ' +
      money(sum.available || 0) + ' available';
  }

  function renderHistory() {
    var wrap = $('history');
    if (!historyEntries.length) {
      wrap.replaceChildren(el('p', { class: 'muted', text: 'No saved versions yet. Copies appear here once this line has been edited.' }));
      return;
    }
    var rows = historyEntries.map(function (e) {
      return el('tr', {}, [
        el('td', { text: fmtWhen(e) }),
        el('td', { text: describe(e.summary) }),
        el('td', { class: 'muted', text: REASONS[e.reason] || REASONS[''] }),
        el('td', { class: 'row-actions' }, [
          el('button', { type: 'button', class: 'link', 'data-act': 'view', 'data-hid': String(e.hid), text: 'View' }),
          el('button', { type: 'button', class: 'link', 'data-act': 'bring', 'data-hid': String(e.hid), text: 'Bring back' })
        ])
      ]);
    });
    var table = el('table', { class: 'schedule history-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'As it was on' }), el('th', { text: 'What it held' }), el('th', { text: 'Kept' }), el('th')
      ])]),
      el('tbody', {}, rows)
    ]);
    var parts = [el('div', { class: 'table-scroll' }, [table])];
    if (historyMore) parts.push(el('button', { type: 'button', class: 'link history-more', 'data-act': 'older', text: 'Show older versions' }));
    wrap.replaceChildren.apply(wrap, parts);
  }

  function bringBack(entry, data) {
    if (!window.confirm('Bring back the version from ' + fmtWhen(entry) + '? It replaces this line for everyone. ' +
      'What is there now is kept in Saved versions first.')) return;
    closeModal();
    replaceRecord(data, 'restore');
  }

  function onHistoryClick(e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn || !loaded) return;
    var act = btn.getAttribute('data-act');
    if (act === 'older') {
      loadHistory(true);
      return;
    }
    var hid = btn.getAttribute('data-hid');
    getJSON(historyBase + '/' + encodeURIComponent(hid)).then(function (full) {
      if (!full) return;
      var data = normalize(full.data);
      if (act === 'view') {
        openModal({
          title: 'Version from ' + fmtWhen(full),
          text: describe(full.summary) + '. ' + (REASONS[full.reason] || REASONS['']) + '.',
          body: buildSummary(data, 'as it was on ' + fmtWhen(full)),
          readOnly: true,
          primary: 'Bring back this version',
          onPrimary: function () { bringBack(full, data); }
        });
      } else {
        bringBack(full, data);
      }
    }).catch(function () {
      setStatus('That saved version could not be loaded. Try again.', true);
    });
  }

  // ---------- Modal ----------

  var modalPrimary = null;

  function openModal(opts) {
    $('modal-title').textContent = opts.title;
    $('modal-text').textContent = opts.text || '';
    var body = $('modal-body');
    body.value = opts.body || '';
    body.readOnly = !!opts.readOnly;
    body.placeholder = opts.placeholder || '';
    $('modal-file-row').hidden = !opts.file;
    $('modal-file').value = '';
    $('modal-error').textContent = '';
    $('modal-error').classList.remove('good');
    $('modal-primary').textContent = opts.primary;
    modalPrimary = opts.onPrimary;
    $('modal').hidden = false;
    body.focus();
    if (opts.readOnly) {
      try { body.setSelectionRange(0, 0); body.scrollTop = 0; } catch (_) { /* ignore */ }
    }
  }

  function closeModal() {
    $('modal').hidden = true;
    modalPrimary = null;
  }

  function modalMessage(text, good) {
    var m = $('modal-error');
    m.textContent = text;
    m.classList.toggle('good', !!good);
  }

  function copyFromModal() {
    var body = $('modal-body');
    var text = body.value;
    function fallback() {
      var ok = false;
      try {
        body.focus();
        body.select();
        ok = typeof document.execCommand === 'function' && document.execCommand('copy');
      } catch (_) {
        ok = false;
      }
      modalMessage(ok ? 'Copied.' : 'Select the text and copy it.', ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { modalMessage('Copied.', true); }, fallback);
    } else {
      fallback();
    }
  }

  function doRestore() {
    var parsed;
    var fromLine = '';
    try {
      parsed = JSON.parse($('modal-body').value);
    } catch (_) {
      modalMessage('That is not valid JSON. Paste the whole backup.');
      return;
    }
    if (isObject(parsed) && typeof parsed.line === 'string') fromLine = parsed.line;
    if (isObject(parsed) && isObject(parsed.data) && !Array.isArray(parsed.dispositions)) parsed = parsed.data;
    if (!validShape(parsed)) {
      modalMessage('That does not look like a credit line backup.');
      return;
    }
    var other = fromLine && fromLine !== LINE
      ? 'This backup is from ' + (LINES[fromLine] || fromLine) + ', not ' + BANK + '. '
      : '';
    if (!window.confirm(other + 'Restore this backup into ' + BANK + '? It replaces this line for everyone. ' +
      'What is there now is kept in Saved versions first.')) return;
    replaceRecord(parsed, 'restore');
    closeModal();
  }

  function onBackupFile() {
    var file = $('modal-file').files && $('modal-file').files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      $('modal-body').value = String(reader.result || '');
      modalMessage('Backup file loaded. Click Restore to use it.', true);
    };
    reader.onerror = function () {
      modalMessage('That file could not be read.');
    };
    reader.readAsText(file);
  }

  // ---------- Wiring ----------

  function bind() {
    var settingsIds = ['limit', 'available', 'tiie', 'spread', 'cushion-amount', 'cushion-note'];
    settingsIds.forEach(function (id) {
      $(id).addEventListener('input', onSettingsEdit);
      $(id).addEventListener('change', onSettingsEdit);
    });

    var container = $('dispositions');
    container.addEventListener('input', onDispEdit);
    container.addEventListener('change', onDispEdit);
    container.addEventListener('click', onDispClick);

    $('schedule').addEventListener('change', onScheduleChange);
    $('add-disposition').addEventListener('click', addDisposition);

    $('whatif-amount').addEventListener('input', function (e) {
      reformatMoney(e.target);
      refreshWhatIf();
    });
    $('whatif-days').addEventListener('change', refreshWhatIf);
    $('whatif-add').addEventListener('click', addWhatIf);

    $('search').addEventListener('input', applySearch);
    $('show-all').addEventListener('click', function () {
      collapsed = {};
      saveCollapsed();
      $('search').value = '';
      applySearch();
    });
    $('hide-all').addEventListener('click', function () {
      record.dispositions.forEach(function (d) { collapsed[d.id] = true; });
      saveCollapsed();
      $('search').value = '';
      applySearch();
    });

    document.addEventListener('focusout', function () { setTimeout(applyHeld, 0); });

    $('copy-summary').addEventListener('click', function () {
      openModal({
        title: 'Summary', text: 'Plain text, ready to paste into a message.',
        body: buildSummary(), readOnly: true, primary: 'Copy', onPrimary: copyFromModal
      });
    });
    $('restore').addEventListener('click', function () {
      openModal({
        title: 'Restore from a backup',
        text: 'Choose a backup file, or paste a backup below. It replaces this line for everyone. What is there now is kept in Saved versions first.',
        body: '', readOnly: false, file: true, placeholder: 'Or paste the backup here', primary: 'Restore', onPrimary: doRestore
      });
    });
    $('modal-file').addEventListener('change', onBackupFile);
    $('history').addEventListener('click', onHistoryClick);
    $('clear').addEventListener('click', function () {
      if (!loaded) return;
      if (!window.confirm('Start this line over? The cushion, every disposition and every payment are removed for everyone.')) return;
      if (!window.confirm('Are you sure? What is there now is kept in Saved versions, so it can be brought back.')) return;
      replaceRecord(emptyRecord(), 'clear');
    });
    $('signout').addEventListener('click', function () {
      fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
        .catch(function () { /* go to login anyway */ })
        .then(toLogin);
    });

    $('modal-primary').addEventListener('click', function () { if (modalPrimary) modalPrimary(); });
    $('modal-close').addEventListener('click', closeModal);
    $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('modal').hidden) closeModal();
    });

    window.addEventListener('beforeunload', function (e) {
      if (dirty || inFlight || saveTimer) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    });
  }

  function setupLine() {
    document.title = BANK + ' line, use of funds';
    $('download-json').setAttribute('href', '/api/lines/' + LINE + '/export.json');
    $('download-csv').setAttribute('href', '/api/lines/' + LINE + '/export.csv');
    $('line-title').textContent = BANK + ' line';
    Array.prototype.forEach.call(document.querySelectorAll('[data-bank]'), function (n) {
      n.textContent = BANK;
    });
  }

  function start() {
    setupLine();
    bind();
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
