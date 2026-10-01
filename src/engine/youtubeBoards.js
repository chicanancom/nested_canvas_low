import { Transform2D, Vec2 } from './math.js';
import { CanvasNode } from './scene.js';
import { CreateNodeCommand, TransformNodeCommand } from './history.js';

export function extractYoutubeId(app, value) {
    const raw = String(value || '').trim();
    const match = raw.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/i);
    return match ? match[1] : (/^[\w-]{11}$/.test(raw) ? raw : null);
  }


export function createYoutubeBoard(app) {
    const input = window.prompt('Dán link YouTube hoặc mã video:');
    const videoId = app.extractYoutubeId(input);
    if (!videoId) {
      if (input !== null) app.showToast('❌ Link YouTube không hợp lệ');
      return;
    }
    const width = 720, height = 405;
    const center = app.camera.screenToWorld(new Vec2(window.innerWidth / 2, window.innerHeight / 2));
    const node = new CanvasNode(
      'YouTube', width, height,
      Transform2D.fromTranslation(center.x - width / 2, center.y - height / 2),
      null, null, app.globalTheme || app.scene.root.style || 'chalkboard',
      app.globalGrid || app.scene.root.gridType || 'grid'
    );
    node.youtubeData = { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
    app.history.execute(new CreateNodeCommand(app.scene.root.id, node), app.scene);
    app.selectedNodeId = node.id;
    app.scheduleContentSave();
    app.updateUI();
    app.broadcastCanvasMirror();
    app.showToast('▶ Đã thêm video YouTube vào bảng');
  }


export function updateYoutubeOverlays(app) {
    const host = document.getElementById('video-overlays');
    if (!host) return;
    const nodes = (app.scene.root.children || []).filter(node => node.youtubeData?.videoId);
    const liveIds = new Set();
    for (const node of nodes) {
      const p0 = app.camera.worldToScreen(node.transform.transformPoint(new Vec2(0, 0)));
      const p1 = app.camera.worldToScreen(node.transform.transformPoint(new Vec2(node.width, node.height)));
      const left = Math.min(p0.x, p1.x), top = Math.min(p0.y, p1.y);
      const width = Math.abs(p1.x - p0.x), height = Math.abs(p1.y - p0.y);
      if (width < 12 || height < 12 || left > window.innerWidth || top > window.innerHeight || left + width < 0 || top + height < 0) continue;
      liveIds.add(node.id);
      let remote = host.querySelector(`[data-node-id="${node.id}"]`);
      if (!remote) {
        remote = document.createElement('div');
        remote.dataset.nodeId = node.id;
        remote.classList.add('youtube-remote');
        remote.style.cssText = 'position:absolute; overflow:hidden; border-radius:8px; background:#111827; background-size:cover; background-position:center;';
        remote.style.backgroundImage = `url(https://img.youtube.com/vi/${node.youtubeData.videoId}/hqdefault.jpg)`;
        const label = document.createElement('div');
        label.textContent = '▶ YouTube · phát trên Display';
        label.style.cssText = 'position:absolute; left:12px; bottom:12px; padding:6px 10px; border-radius:6px; background:rgba(15,23,42,.86); color:#fff; font:600 12px Outfit,sans-serif;';
        remote.appendChild(label);
        const controls = document.createElement('div');
        controls.style.cssText = 'position:absolute; left:12px; top:12px; display:flex; gap:6px;';
        const actionLabels = {
          play: 'Phát', pause: 'Tạm dừng', stop: 'Dừng', unmute: 'Bật âm thanh',
          backward: 'Lùi 10 giây', forward: 'Tiến 10 giây', restart: 'Phát lại từ đầu',
        };
        label.setAttribute('role', 'status');
        label.setAttribute('aria-live', 'polite');
        let feedbackTimer;
        [['▶', 'play'], ['Ⅱ', 'pause'], ['■', 'stop'], ['🔊', 'unmute'], ['−10', 'backward'], ['+10', 'forward'], ['↺', 'restart']].forEach(([text, action]) => {
          const button = document.createElement('button');
          button.type = 'button'; button.textContent = text;
          button.title = actionLabels[action];
          button.setAttribute('aria-label', actionLabels[action]);
          button.className = 'youtube-control';
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            const sent = app.sendYoutubeControl(node.id, action);
            controls.querySelectorAll('.youtube-control').forEach(control => {
              control.classList.remove('is-sent', 'is-failed');
            });
            button.classList.add(sent ? 'is-sent' : 'is-failed');
            label.textContent = sent
              ? `✓ Đã gửi: ${actionLabels[action]}`
              : '⚠ Chưa kết nối Display';
            clearTimeout(feedbackTimer);
            feedbackTimer = setTimeout(() => {
              button.classList.remove('is-sent', 'is-failed');
              label.textContent = '▶ YouTube · phát trên Display';
            }, 1600);
          });
          controls.appendChild(button);
        });
        remote.appendChild(controls);
        const close = document.createElement('button');
        close.type = 'button';
        close.dataset.deleteNodeId = node.id;
        close.textContent = '✕';
        close.title = 'Xóa video YouTube';
        close.style.cssText = 'position:absolute; z-index:2; width:30px; height:30px; padding:0; border:1px solid rgba(255,255,255,.45); border-radius:50%; background:rgba(15,23,42,.92); color:#fff; font-size:16px; line-height:28px; cursor:pointer; touch-action:manipulation;';
        close.addEventListener('click', (event) => {
          event.stopPropagation();
          app.deleteBoard(node.id);
        });
        remote.appendChild(close);
        let drag = null;
        remote.addEventListener('pointerdown', (event) => {
          if (event.target.closest('button, details, summary')) return;
          drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, tx: node.transform.tx, ty: node.transform.ty, initial: node.transform.clone() };
          app.selectedNodeId = node.id;
          remote.setPointerCapture?.(event.pointerId);
          remote.classList.add('is-dragging');
          event.preventDefault();
        });
        remote.addEventListener('pointermove', (event) => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          node.transform.tx = drag.tx + (event.clientX - drag.startX) / app.camera.zoom;
          node.transform.ty = drag.ty + (event.clientY - drag.startY) / app.camera.zoom;
          app.requestRender();
          if (app.syncClient?.isConnected) app.syncClient.send('NODE_TRANSFORM', {
            clientId: app.clientId, nodeId: node.id, x: node.transform.tx, y: node.transform.ty,
            w: node.width, h: node.height,
          });
        });
        const finishDrag = (event) => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          remote.releasePointerCapture?.(event.pointerId);
          remote.classList.remove('is-dragging');
          if (drag.tx !== node.transform.tx || drag.ty !== node.transform.ty) {
            app.history.execute(new TransformNodeCommand(node.id, drag.initial, node.transform.clone()), app.scene);
          }
          app.scheduleContentSave();
          drag = null;
        };
        remote.addEventListener('pointerup', finishDrag);
        remote.addEventListener('pointercancel', finishDrag);
        host.appendChild(remote);
      }
      remote.style.left = `${left}px`; remote.style.top = `${top}px`;
      remote.style.width = `${width}px`; remote.style.height = `${height}px`;
      remote.style.display = 'block';
      const close = remote.querySelector(`[data-delete-node-id="${node.id}"]`);
      if (close) {
        close.style.right = '8px'; close.style.top = '8px';
        close.style.display = 'block';
      }
    }
    host.querySelectorAll('[data-node-id]').forEach(nodeEl => { if (!liveIds.has(nodeEl.dataset.nodeId)) nodeEl.remove(); });
  }


export function sendYoutubeControl(app, nodeId, action) {
    if (!app.syncClient || !app.syncClient.isConnected) {
      app.showToast('⚠️ Chưa kết nối màn hình Display');
      return false;
    }
    app.syncClient.send('YOUTUBE_CONTROL', { nodeId, action, sentAt: Date.now() });
    return true;
  }
