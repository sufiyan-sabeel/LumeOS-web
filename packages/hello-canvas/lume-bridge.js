/*
 * LumeOS bridge for installed web apps.
 * Provides window.LumeOS to a sandboxed package by relaying calls to the
 * parent desktop over postMessage. No network access is required.
 */
(function () {
  var pending = {};
  var seq = 0;

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'lume:result') return;
    var id = msg.__id;
    if (id && pending[id]) {
      pending[id](msg.result);
      delete pending[id];
    }
  });

  function call(method, args) {
    return new Promise(function (resolve) {
      var id = ++seq;
      pending[id] = resolve;
      parent.postMessage({ type: 'lume:call', method: method, args: args, __id: id }, '*');
    });
  }

  window.LumeOS = {
    version: '1.0.0',
    fs: {
      read: function (p) { return call('fs.read', [p]); },
      write: function (p, c) { return call('fs.write', [p, c]); },
      list: function (p) { return call('fs.list', [p]); }
    },
    notifications: {
      send: function (title, body) { return call('notify', [title, body]); }
    }
  };
})();
