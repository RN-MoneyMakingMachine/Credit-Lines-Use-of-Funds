(function () {
  'use strict';

  var PULL_MS = 60000;

  function $(id) { return document.getElementById(id); }

  function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function money(n) {
    var r = Math.round(n || 0);
    return (r < 0 ? '-$' : '$') + group(Math.abs(r));
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function toLogin() { window.location.href = '/login'; }


  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
  }

  function render(data) {
    var drawn = 0;
    var interest = 0;
    var count = 0;
    var safe = 0;
    var nextLines = [];
    (data.lines || []).forEach(function (line) {
      var row = document.querySelector('.fund[data-line="' + line.id + '"]');
      if (!row) return;
      var limit = row.querySelector('[data-num="limit"]');
      limit.textContent = line.limit > 0 ? money(line.limit) : 'Not set';
      limit.classList.toggle('muted', !(line.limit > 0));
      row.querySelector('[data-num="available"]').textContent = money(line.available);
      row.querySelector('[data-num="drawn"]').textContent = money(line.drawn);
      var left = row.querySelector('[data-num="left"]');
      left.textContent = money(line.left);
      left.classList.toggle('bad', line.left < 0);
      drawn += line.drawn;
      interest += line.interest;
      count += line.count;
      safe += line.safe || 0;
      if (line.next) {
        var p = document.createElement('p');
        p.className = 'next-line';
        p.appendChild(document.createTextNode('Next payment to ' + line.name + ': '));
        var strong = document.createElement('strong');
        strong.textContent = money(line.next.amount) + ' on ' + fmtDate(line.next.date);
        p.appendChild(strong);
        p.appendChild(document.createTextNode('. Interest is paid monthly.'));
        nextLines.push(p);
      }
    });
    var nextWrap = document.getElementById('next-payments');
    nextWrap.replaceChildren.apply(nextWrap, nextLines);
    $('combined').textContent = (drawn > 0
      ? 'Across both lines we have drawn ' + money(drawn) + ' in ' + plural(count, 'disposition', 'dispositions') +
        '. Paying it back will cost ' + money(interest) + ' in interest, ' + money(drawn + interest) + ' in total.'
      : 'Nothing drawn from either line yet.') +
      (safe > 0 ? ' The repayment safe across the lines holds ' + money(safe) + '.' : '');
    $('status').textContent = 'Open a line to plan it. Changes save automatically.';
    $('status').classList.remove('bad');
  }

  var loading = false;
  var again = false;   // a change arrived while loading: load once more afterwards

  function load() {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    again = false;
    fetch('/api/summary', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
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
    $('signout').addEventListener('click', function () {
      fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
        .catch(function () { /* go to login anyway */ })
        .then(toLogin);
    });
    load();
    if (typeof window.EventSource === 'function') {
      var source = new window.EventSource('/api/events');
      source.addEventListener('changed', load);
    }
    setInterval(load, PULL_MS);
    // Coming back with the Back button can show a cached page: refresh its numbers.
    window.addEventListener('pageshow', function (e) { if (e.persisted) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
