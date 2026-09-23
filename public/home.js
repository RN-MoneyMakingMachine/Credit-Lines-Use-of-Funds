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

  function render(data) {
    var drawn = 0;
    var interest = 0;
    var count = 0;
    (data.lines || []).forEach(function (line) {
      var row = document.querySelector('.fund[data-line="' + line.id + '"]');
      if (!row) return;
      row.querySelector('[data-num="available"]').textContent = money(line.available);
      row.querySelector('[data-num="drawn"]').textContent = money(line.drawn);
      var left = row.querySelector('[data-num="left"]');
      left.textContent = money(line.left);
      left.classList.toggle('bad', line.left < 0);
      drawn += line.drawn;
      interest += line.interest;
      count += line.count;
    });
    $('combined').textContent = drawn > 0
      ? 'Across both lines we have drawn ' + money(drawn) + ' in ' + plural(count, 'disposition', 'dispositions') +
        '. Paying it back will cost ' + money(interest) + ' in interest, ' + money(drawn + interest) + ' in total.'
      : 'Nothing drawn from either line yet.';
    $('status').textContent = 'Open a line to plan it. Changes save automatically.';
    $('status').classList.remove('bad');
  }

  var loading = false;

  function load() {
    if (loading) return;
    loading = true;
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
      .then(function () { loading = false; });
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
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
