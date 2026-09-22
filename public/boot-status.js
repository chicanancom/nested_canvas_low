(function () {
  var ready = false;
  var pending = '';
  var diagnosticMode = /[?&]diagnostics=1(?:&|$)/.test(location.search);
  function show(message) {
    pending = message;
    if (!document.body) return;
    var box = document.getElementById('startup-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'startup-error';
      box.style.cssText = 'position:fixed;inset:16px;z-index:99999;background:#101923;color:#f0f6fc;padding:24px;overflow:auto;font:16px/1.5 sans-serif;border:1px solid #58a6ff;border-radius:12px';
      var title = document.createElement('h2');
      title.textContent = ready ? 'Có lỗi khi thao tác trên bảng' : 'Không khởi động được bảng';
      var advice = document.createElement('p');
      advice.textContent = 'Bấm tải lại để nhận bản mới từ server. Nếu lỗi tiếp tục, gửi lại nội dung lỗi bên dưới.';
      var detail = document.createElement('pre');
      detail.id = 'startup-error-detail';
      detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px';
      var retry = document.createElement('button');
      retry.textContent = 'Tải lại';
      retry.style.cssText = 'padding:12px 24px;font-size:16px';
      retry.onclick = function () { location.reload(); };
      box.appendChild(title); box.appendChild(advice); box.appendChild(detail); box.appendChild(retry);
      document.body.appendChild(box);
    }
    document.getElementById('startup-error-detail').textContent = message + '\n\n' + navigator.userAgent;
  }
  window.addEventListener('error', function (event) {
    if (event.message) show(event.message + '\n' + (event.filename || '') + ':' + (event.lineno || ''));
    else if (!ready && event.target && event.target.tagName === 'SCRIPT') show('Không tải được mã ứng dụng: ' + event.target.src);
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    if (!ready) show(String(event.reason && event.reason.message || event.reason));
  });
  document.addEventListener('DOMContentLoaded', function () { if (pending) show(pending); });
  window.addEventListener('nestedcanvas:ready', function () { ready = true; });
  if (diagnosticMode) {
    setInterval(function () {
      if (!document.body) return;
      var panel = document.getElementById('canvas-diagnostics');
      if (!panel) {
        panel = document.createElement('pre');
        panel.id = 'canvas-diagnostics';
        panel.style.cssText = 'position:fixed;left:8px;top:72px;z-index:99998;max-width:90vw;white-space:pre-wrap;background:#111e;color:#fff;padding:8px;font:11px/1.4 monospace;pointer-events:none';
        document.body.appendChild(panel);
      }
      var app = window.app;
      var canvas = document.getElementById('canvas');
      var text = 'LAN diagnostic · ' + (ready ? 'App ready' : 'App not ready');
      text += '\nViewport: ' + innerWidth + '×' + innerHeight + ' DPR: ' + devicePixelRatio;
      text += '\nCanvas: ' + (canvas ? canvas.width + '×' + canvas.height : 'missing');
      if (app) {
        text += '\nFrames: ' + app.renderer.frameCount + ' / FPS: ' + app.renderer.stats.fps;
        text += '\nPages: ' + app.pages.length + ' / Current: ' + (app.currentPageIndex + 1);
        text += '\nSync: ' + (app.syncClient && app.syncClient.isConnected);
        text += '\nZoom: ' + app.camera.zoom;
      }
      panel.textContent = text;
    }, 1000);
  }
  setTimeout(function () {
    if (!ready && !pending) show('Ứng dụng chưa khởi động sau 30 giây. Kiểm tra kết nối hoặc phiên bản Android System WebView.');
  }, 30000);
})();
