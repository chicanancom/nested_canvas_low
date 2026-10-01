import { Vec2 } from './math.js';

export async function changePdfPage(app, nodeId, index, renderPage = null) {
  const node = app.scene.getNode(nodeId);
  if (!node?.pdfData || node.pdfLoading || !Number.isInteger(index) || index < 0 || index >= node.pdfData.pageCount || index === node.pdfData.pageIndex) return;
  node.pdfLoading = true;
  try {
    if (!renderPage) {
      const native = window.Capacitor?.isNativePlatform() && window.Capacitor.getPlatform() === 'android';
      renderPage = native
        ? (await import('../storage/nativePdfImporter.js')).renderNativePdfPage
        : (await import('../storage/pdfImporter.js')).renderPdfPage;
    }
    const page = await renderPage(node.pdfData.source, index);
    // A document may have been deleted or its session closed while rendering.
    if (app.scene.getNode(nodeId) !== node) return;
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Không hiển thị được trang PDF.'));
      image.src = page.src;
    });
    if (app.scene.getNode(nodeId) !== node) return;
    node.image = image;
    node.height = node.width * page.height / page.width;
    node.showPdfPage(index);
    node.name = `📄 ${node.pdfData.name} · ${index + 1}/${node.pdfData.pageCount}`;
    app.scheduleContentSave();
    app.updateUI();
    app.broadcastCanvasMirror();
    app.requestRender();
  } finally {
    node.pdfLoading = false;
  }
}

export function updatePdfOverlays(app) {
  const host = document.getElementById('video-overlays');
  if (!host) return;
  const visible = new Set();
  const visit = node => {
    if (node.pdfData) {
      const transform = app.scene.computeScreenTransform(node.id, app.camera);
      const first = transform.transformPoint(new Vec2(0, 0));
      const last = transform.transformPoint(new Vec2(node.width, node.height));
      const left = Math.min(first.x, last.x), top = Math.min(first.y, last.y);
      const width = Math.abs(last.x - first.x), height = Math.abs(last.y - first.y);
      if (width > 20 && left < window.innerWidth && top < window.innerHeight && left + width > 0 && top + height > 0) {
        visible.add(node.id);
        let controls = host.querySelector(`[data-pdf-node-id="${node.id}"]`);
        if (!controls) {
          controls = document.createElement('div');
          controls.dataset.pdfNodeId = node.id;
          controls.className = 'pdf-navigation';
          for (const [text, direction, label] of [['‹', -1, 'Trang PDF trước'], ['›', 1, 'Trang PDF sau']]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.dataset.direction = direction;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', event => {
              event.stopPropagation();
              changePdfPage(app, node.id, node.pdfData.pageIndex + direction)
                .catch(error => app.showToast(`❌ ${error.message}`, 4000));
            });
            controls.appendChild(button);
            if (direction === -1) {
              const count = document.createElement('span');
              count.className = 'pdf-page-count';
              count.setAttribute('aria-live', 'polite');
              controls.appendChild(count);
            }
          }
          host.appendChild(controls);
        }
        controls.style.left = `${Math.max(4, Math.min(window.innerWidth - 144, left + width / 2 - 70))}px`;
        controls.style.top = `${Math.max(4, Math.min(window.innerHeight - 44, top + height + 4))}px`;
        const counter = controls.querySelector('.pdf-page-count');
        const label = node.pdfLoading ? 'Đang tải…' : `${node.pdfData.pageIndex + 1} / ${node.pdfData.pageCount}`;
        if (counter.textContent !== label) counter.textContent = label;
        controls.querySelector('[data-direction="-1"]').disabled = node.pdfLoading || node.pdfData.pageIndex <= 0;
        controls.querySelector('[data-direction="1"]').disabled = node.pdfLoading || node.pdfData.pageIndex >= node.pdfData.pageCount - 1;
      }
    }
    for (const child of node.children || []) visit(child);
  };
  visit(app.scene.root);
  host.querySelectorAll('[data-pdf-node-id]').forEach(control => {
    if (!visible.has(control.dataset.pdfNodeId)) control.remove();
  });
}
