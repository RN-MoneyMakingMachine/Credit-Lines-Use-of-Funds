(function () {
  'use strict';

  var form = document.getElementById('login-form');
  var input = document.getElementById('code');
  var button = document.getElementById('open');
  var error = document.getElementById('error');

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    error.textContent = '';
    var code = input.value;
    if (!code) {
      error.textContent = 'Type the access code.';
      return;
    }
    button.disabled = true;
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code: code })
    }).then(function (res) {
      if (res.ok) {
        window.location.href = '/';
        return;
      }
      button.disabled = false;
      if (res.status === 429) {
        error.textContent = 'Too many attempts. Try again in a few minutes.';
      } else {
        error.textContent = 'That code does not open the record.';
      }
      input.select();
    }).catch(function () {
      button.disabled = false;
      error.textContent = 'No connection. Try again.';
    });
  });
})();
