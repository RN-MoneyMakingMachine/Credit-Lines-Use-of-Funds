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
  var COLLAPSE_KEY = 'kapital.collapsed';

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
    return { id: uid(), name: '', amount: 0, risk: '', revenue: false, back: 0, backDate: '', paid: false };
  }

  function newDisposition() {
    var now = stamp();
    return {
      id: uid(), name: '', amount: 0, date: todayStr(), days: 90,
      created: now, updated: now, repaid: false, payments: [emptyPayment()]
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
      paid: !!p.paid
    };
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
      available: r.available, tiie: r.tiie, spread: r.spread,
      cushion: { amount: r.cushion.amount, note: r.cushion.note },
      settingsUpdated: r.settingsUpdated
    };
  }

  function assignSettings(target, src) {
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

  function totals(r) {
    var annual = annualRate(r);
    var t = {
      annual: annual, drawn: 0, interest: 0, revenue: 0, obligations: 0,
      back: 0, backCost: 0, hasBack: false, count: r.dispositions.length
    };
    r.dispositions.forEach(function (d) {
      t.drawn += d.amount;
      t.interest += interestOf(d.amount, d.days, annual);
      d.payments.forEach(function (p) {
        if (p.revenue) {
          t.revenue += p.amount;
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
    return t;
  }

  // ---------- Status ----------

  function setStatus(text, isError) {
    var s = $('status');
    s.textContent = text;
    s.classList.toggle('bad', !!isError);
  }

  function isEmptyRecord(r) {
    return !r.dispositions.length && !r.available && !r.cushion.amount && !r.cushion.note;
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
      'Paid', 'Payment', 'Amount', 'If we do not pay', 'Adds revenue', 'Brings back', 'Comes back on', ''
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
    block.querySelector('.facts').textContent =
      'Back to Kapital on ' + fmtDate(maturity(d)) + '. Interest ' + money(interest) +
      '. Total to pay ' + money(d.amount + interest) + '.';

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
    if (p.revenue && parseDate(p.backDate) !== null) {
      var diff = Math.round((due - parseDate(p.backDate)) / DAY_MS);
      var sep = nodes.length ? ' ' : '';
      if (diff > 0) text(sep + 'Arrives ' + plural(diff, 'day', 'days') + ' before Kapital is due.');
      else if (diff < 0) {
        if (sep) text(sep);
        nodes.push(el('strong', { class: 'bad', text: 'Arrives ' + plural(-diff, 'day', 'days') + ' after Kapital is due.' }));
      } else text(sep + 'Arrives the day Kapital is due.');
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

    // Allocation bar and legend
    var base = Math.max(record.available, record.cushion.amount + t.drawn, 1);
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
    $('big-cushion').textContent = money(record.cushion.amount);
    $('big-drawn').textContent = money(t.drawn);
    $('big-drawn-label').textContent = 'drawn from Kapital in ' + plural(t.count, 'disposition', 'dispositions');
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
      ? 'Paying Kapital back will cost ' + money(t.interest) + ' in interest. The ' + money(t.drawn) +
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
    split.replaceChildren.apply(split, parts);

    record.dispositions.forEach(function (d, i) { refreshBlock(d, i, annual); });
    renderSchedule(annual);
  }

  function renderSettings() {
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
    var focusId = active && wrap.contains(active) ? active.getAttribute('data-id') : null;

    var items = record.dispositions
      .map(function (d, i) { return { d: d, i: i, due: maturity(d) }; })
      .filter(function (x) { return x.d.amount > 0; })
      .sort(function (a, b) { return a.due - b.due || a.i - b.i; });

    if (!items.length) {
      wrap.replaceChildren(el('p', { class: 'muted', text: 'Nothing to pay yet.' }));
      return;
    }

    var sum = { principal: 0, interest: 0, total: 0, repaid: 0 };
    var rows = items.map(function (x) {
      var d = x.d;
      var interest = interestOf(d.amount, d.days, annual);
      sum.principal += d.amount;
      sum.interest += interest;
      sum.total += d.amount + interest;
      if (d.repaid) sum.repaid += d.amount + interest;
      return el('tr', { class: d.repaid ? 'is-paid' : '' }, [
        el('td', { text: fmtDate(x.due) }),
        el('td', { text: dispName(d) }),
        el('td', { class: 'num', text: money(d.amount) }),
        el('td', { class: 'num', text: money(interest) }),
        el('td', { class: 'num', text: money(d.amount + interest) }),
        el('td', { class: 'check' }, [
          el('input', { type: 'checkbox', 'data-id': d.id, 'aria-label': 'Paid ' + dispName(d), checked: d.repaid })
        ])
      ]);
    });

    var table = el('table', { class: 'schedule' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Date' }), el('th', { text: 'Disposition' }),
        el('th', { class: 'num', text: 'Principal' }), el('th', { class: 'num', text: 'Interest' }),
        el('th', { class: 'num', text: 'Total to pay' }), el('th', { class: 'check', text: 'Paid' })
      ])]),
      el('tbody', {}, rows),
      el('tfoot', {}, [el('tr', {}, [
        el('td', { text: 'Total' }), el('td'),
        el('td', { class: 'num', text: money(sum.principal) }),
        el('td', { class: 'num', text: money(sum.interest) }),
        el('td', { class: 'num', text: money(sum.total) }),
        el('td')
      ])])
    ]);

    wrap.replaceChildren(
      el('div', { class: 'table-scroll' }, [table]),
      el('p', { class: 'muted schedule-note', text: 'Repaid so far ' + money(sum.repaid) + '. Still to pay ' + money(sum.total - sum.repaid) + '.' })
    );

    if (focusId) {
      var again = wrap.querySelector('input[data-id="' + focusId + '"]');
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
    if (!d || d.repaid === t.checked) return;
    d.repaid = t.checked;
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
      available: local.available, tiie: local.tiie, spread: local.spread,
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
    window.location.href = '/login';
  }

  function flush() {
    if (inFlight) return;          // the running save picks up the queued edits when it finishes
    if (!dirty) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    dirty = false;
    inFlight = true;

    var payload = buildPayload();
    fetch('/api/record', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ baseVersion: version, data: payload })
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
    return fetch('/api/record', {
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
    }).catch(function () { /* the next pull retries */ }).then(function () {
      pulling = false;
    });
  }

  function connectLive() {
    if (typeof window.EventSource === 'function') {
      var source = new window.EventSource('/api/events');
      source.addEventListener('changed', function (e) {
        var v;
        try { v = JSON.parse(e.data).version; } catch (_) { return; }
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
    }).catch(function () {
      setStatus('Could not load the record. Retrying.', true);
      setTimeout(load, RETRY_DELAY);
    });
  }

  // ---------- Replace (restore and clear) ----------

  function replaceRecord(data) {
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
    markDirty();
  }

  // ---------- Summary ----------

  function buildSummary() {
    var t = totals(record);
    var annual = t.annual;
    var lines = [];
    lines.push('AROMARIA, Kapital line, ' + fmtToday());
    lines.push(
      'Available today ' + money(record.available) + '. Cushion ' + money(record.cushion.amount) +
      (record.cushion.note.trim() ? ' (' + record.cushion.note.trim() + ')' : '') + '. Drawn ' + money(t.drawn) +
      ' in ' + plural(t.count, 'disposition', 'dispositions') + '. Still available ' + money(t.left) + '.' +
      (t.left < 0 ? ' Over the available line by ' + money(-t.left) + '.' : '')
    );
    lines.push(
      'TIIE ' + record.tiie + '% plus spread ' + record.spread + '%, ' + pct(annual * 100) + ' a year, ' +
      pct(annual * 100 / 12) + ' a month. Interest to Kapital ' + money(t.interest) + '. Total to repay ' +
      money(t.drawn + t.interest) + '.'
    );
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

    record.dispositions.forEach(function (d) {
      var interest = interestOf(d.amount, d.days, annual);
      var due = maturity(d);
      var drawnOn = parseDate(d.date);
      lines.push('');
      lines.push(
        dispName(d) + ', ' + money(d.amount) + ' drawn' + (drawnOn !== null ? ' on ' + fmtDate(drawnOn) : '') +
        ' for ' + d.days + ' days. Back to Kapital on ' + fmtDate(due) + '. Interest ' + money(interest) +
        '. Total to pay ' + money(d.amount + interest) + '.' + (d.repaid ? ' Repaid.' : '')
      );
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
          if (backT !== null) {
            var days = Math.round((due - backT) / DAY_MS);
            line += days > 0 ? ' Arrives ' + plural(days, 'day', 'days') + ' before Kapital is due.'
              : days < 0 ? ' Arrives ' + plural(-days, 'day', 'days') + ' after Kapital is due.'
                : ' Arrives the day Kapital is due.';
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

  // ---------- Modal ----------

  var modalPrimary = null;

  function openModal(opts) {
    $('modal-title').textContent = opts.title;
    $('modal-text').textContent = opts.text || '';
    var body = $('modal-body');
    body.value = opts.body || '';
    body.readOnly = !!opts.readOnly;
    body.placeholder = opts.placeholder || '';
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
    try {
      parsed = JSON.parse($('modal-body').value);
    } catch (_) {
      modalMessage('That is not valid JSON. Paste the whole backup.');
      return;
    }
    if (isObject(parsed) && isObject(parsed.data) && !Array.isArray(parsed.dispositions)) parsed = parsed.data;
    if (!validShape(parsed)) {
      modalMessage('That does not look like a Kapital line backup.');
      return;
    }
    replaceRecord(parsed);
    closeModal();
  }

  // ---------- Wiring ----------

  function bind() {
    var settingsIds = ['available', 'tiie', 'spread', 'cushion-amount', 'cushion-note'];
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
    $('backup').addEventListener('click', function () {
      openModal({
        title: 'Backup', text: 'The full record. Copy it and keep it somewhere safe.',
        body: JSON.stringify(buildPayload(), null, 2), readOnly: true, primary: 'Copy', onPrimary: copyFromModal
      });
    });
    $('restore').addEventListener('click', function () {
      openModal({
        title: 'Restore', text: 'Paste a backup. It replaces the record for everyone.',
        body: '', readOnly: false, placeholder: 'Paste the backup here', primary: 'Restore', onPrimary: doRestore
      });
    });
    $('clear').addEventListener('click', function () {
      if (!loaded) return;
      if (!window.confirm('Clear everything? The cushion, every disposition and every payment are removed for everyone.')) return;
      if (!window.confirm('Are you sure? This cannot be undone unless you have a backup.')) return;
      replaceRecord(emptyRecord());
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

  function start() {
    bind();
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
