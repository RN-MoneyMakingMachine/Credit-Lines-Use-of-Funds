(function () {
  'use strict';

  var PULL_MS = 60000;

  function $(id) { return document.getElementById(id); }

  function money(n) {
    var r = Math.round(n || 0);
    return (r < 0 ? '-$' : '$') + String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function cell(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    e.textContent = text;
    return e;
  }

  function toLogin() { window.location.href = '/login?next=%2Fcash-flow'; }

  function render(data) {
    var wrap = $('cashflow');
    if (!data.rows.length) {
      $('cashflow-sentence').textContent = 'Nothing planned yet. Draw on a line or add payments that bring money back, and the months show up here.';
      wrap.replaceChildren(cell('p', 'muted', 'No months to show yet.'));
      $('status').textContent = 'Up to date. This page follows the credit lines.';
      return;
    }

    var t = data.totals;
    $('cashflow-sentence').textContent = 'Over the months below we pay the banks ' + money(t.outTotal) +
      ' and expect ' + money(t.back) + ' back' +
      (t.safe > 0 ? ', ' + money(t.safe) + ' of it set aside for the credit.' : '.');

    var table = document.createElement('table');
    table.className = 'schedule';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    hr.appendChild(cell('th', '', 'Month'));
    data.lines.forEach(function (l) { hr.appendChild(cell('th', 'num', 'To ' + l.name)); });
    ['Total to pay', 'Coming back', 'For the credit', 'Net'].forEach(function (h) { hr.appendChild(cell('th', 'num', h)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    data.rows.forEach(function (r) {
      var tr = document.createElement('tr');
      if (r.key === 'past') tr.className = 'is-past';
      tr.appendChild(cell('td', '', r.label));
      data.lines.forEach(function (l) { tr.appendChild(cell('td', 'num', r.out[l.id] ? money(r.out[l.id]) : '')); });
      tr.appendChild(cell('td', 'num', r.outTotal ? money(r.outTotal) : ''));
      tr.appendChild(cell('td', 'num', r.back ? money(r.back) : ''));
      tr.appendChild(cell('td', 'num', r.safe ? money(r.safe) : ''));
      tr.appendChild(cell('td', 'num' + (r.net < 0 ? ' bad' : ''), money(r.net)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var tfoot = document.createElement('tfoot');
    var fr = document.createElement('tr');
    fr.appendChild(cell('td', '', 'Total'));
    data.lines.forEach(function (l) { fr.appendChild(cell('td', 'num', money(t.out[l.id]))); });
    fr.appendChild(cell('td', 'num', money(t.outTotal)));
    fr.appendChild(cell('td', 'num', money(t.back)));
    fr.appendChild(cell('td', 'num', money(t.safe)));
    fr.appendChild(cell('td', 'num' + (t.net < 0 ? ' bad' : ''), money(t.net)));
    tfoot.appendChild(fr);
    table.appendChild(tfoot);

    var scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.appendChild(table);
    wrap.replaceChildren(scroll);
    $('status').textContent = 'Up to date. This page follows the credit lines.';
    $('status').classList.remove('bad');
  }

  var loading = false;
  var again = false;

  function load() {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    again = false;
    fetch('/api/cashflow', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 401) {
          toLogin();
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () {
        $('status').textContent = 'No connection to the record. Retrying.';
        $('status').classList.add('bad');
      })
      .then(function () {
        loading = false;
        if (again) load();
      });
  }

  function start() {
    load();
    if (typeof window.EventSource === 'function') {
      var source = new window.EventSource('/api/events');
      source.addEventListener('changed', load);
    }
    setInterval(load, PULL_MS);
    window.addEventListener('pageshow', function (e) { if (e.persisted) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
