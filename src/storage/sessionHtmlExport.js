import { db } from './db.js';

/**
   * Xuất bài giảng ra trang Web HTML Độc Lập (.html)
   * Tự chứa toàn bộ dữ liệu + Trình xem Canvas tương tác + Cây phân cấp rõ ràng + Chế độ Giáo Trình
   * Hỗ trợ xuất toàn bộ hoặc chỉ xuất các bảng được chọn
   */
export async function exportSessionHTML(manager, sessionId, selectedBoardIds = null) {
    if (manager.currentSessionId === sessionId) {
      await manager.flushSave();
    }
    const session = await db.getFullSession(sessionId);
    if (!session || !session.content?.scene?.root) return false;

    let sceneRoot = session.content.scene.root;
    if (Array.isArray(selectedBoardIds) && selectedBoardIds.length > 0) {
      const isSelectedOrHasDescendant = (node) => {
        if (!node) return false;
        if (selectedBoardIds.includes(node.id)) return true;
        if (Array.isArray(node.children)) {
          return node.children.some(isSelectedOrHasDescendant);
        }
        return false;
      };

      const filterNode = (node) => {
        if (!node) return null;
        const copy = { ...node };
        if (node.id !== session.content.scene.root.id && !selectedBoardIds.includes(node.id)) {
          copy.elements = [];
        }
        if (Array.isArray(node.children)) {
          copy.children = node.children
            .filter(isSelectedOrHasDescendant)
            .map(filterNode);
        }
        return copy;
      };

      sceneRoot = filterNode(sceneRoot);
    }

    const sessionData = {
      meta: session.meta,
      content: {
        ...session.content,
        scene: {
          ...session.content.scene,
          root: sceneRoot,
        },
      },
      exportedAt: new Date().toLocaleString('vi-VN'),
    };

    const safeName = (session.meta.name || 'Bai_giang').replace(/[^a-z0-9\u00C0-\u024F\u1EA0-\u1EF9]/gi, '_');
    const htmlContent = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
  <title>${session.meta.name || 'Bài giảng'} - NestedCanvas Viewer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body, html { width: 100%; height: 100%; overflow: hidden; background: #0d1117; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #f0f6fc; }
    #viewer-container { width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; }

    /* Thanh điều khiển trên cùng (Header) */
    .viewer-header {
      position: absolute; top: 12px; left: 16px; right: 16px;
      display: flex; justify-content: space-between; align-items: center;
      background: rgba(13, 17, 23, 0.92); backdrop-filter: blur(16px);
      border: 1px solid rgba(88, 166, 255, 0.25); border-radius: 12px;
      padding: 10px 16px; z-index: 100; box-shadow: 0 12px 32px rgba(0,0,0,0.6);
      flex-wrap: wrap; gap: 8px;
    }
    .brand-title { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .session-title { font-size: 15px; font-weight: 700; color: #58a6ff; display: flex; align-items: center; gap: 6px; }
    .session-date { font-size: 11px; color: #8b949e; }

    .viewer-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .viewer-btn {
      background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15);
      color: #c9d1d9; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.2s;
    }
    .viewer-btn:hover { background: rgba(88, 166, 255, 0.15); color: #58a6ff; border-color: #58a6ff; }
    .viewer-btn.active { background: #1f6feb; color: #ffffff; border-color: #58a6ff; }

    .board-select {
      background: #161b22; border: 1px solid rgba(88, 166, 255, 0.3); color: #58a6ff;
      border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 600; outline: none; cursor: pointer;
      max-width: 220px;
    }

    /* Thanh Breadcrumb hiển thị cấp bậc đang xem */
    .breadcrumb-bar {
      position: absolute; top: 68px; left: 16px; z-index: 90;
      display: flex; align-items: center; gap: 6px;
      background: rgba(13, 17, 23, 0.85); backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px;
      padding: 5px 12px; font-size: 12px; color: #8b949e;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .breadcrumb-node { color: #58a6ff; cursor: pointer; font-weight: 600; }
    .breadcrumb-node:hover { text-decoration: underline; }
    .breadcrumb-sep { color: #484f58; font-size: 10px; }

    /* Khung vẽ Canvas */
    #canvas-wrap { width: 100%; height: 100%; position: relative; }
    canvas { width: 100%; height: 100%; display: block; background: #0d1117; cursor: grab; }
    canvas:active { cursor: grabbing; }

    /* Cây phân cấp bài giảng Sidebar */
    .hierarchy-sidebar {
      position: absolute; top: 68px; right: 16px; bottom: 44px; width: 320px;
      background: rgba(13, 17, 23, 0.95); backdrop-filter: blur(20px);
      border: 1px solid rgba(88, 166, 255, 0.3); border-radius: 12px;
      padding: 14px; z-index: 105; box-shadow: 0 16px 40px rgba(0,0,0,0.7);
      display: flex; flex-direction: column; gap: 10px;
      transition: transform 0.25s ease, opacity 0.25s ease;
    }
    .hierarchy-sidebar.hidden {
      transform: translateX(120%);
      opacity: 0;
      pointer-events: none;
    }
    .sidebar-header {
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 8px;
    }
    .sidebar-title { font-size: 14px; font-weight: 700; color: #58a6ff; display: flex; align-items: center; gap: 6px; }
    .sidebar-close { background: none; border: none; color: #8b949e; font-size: 16px; cursor: pointer; }
    .sidebar-close:hover { color: #f0f6fc; }

    .sidebar-search {
      background: #161b22; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px;
      padding: 6px 10px; color: #f0f6fc; font-size: 12px; outline: none;
    }
    .sidebar-search:focus { border-color: #58a6ff; }

    .tree-scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-right: 4px; }
    .tree-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; border-radius: 8px; cursor: pointer;
      font-size: 13px; color: #c9d1d9; transition: all 0.15s;
      border: 1px solid transparent;
    }
    .tree-item:hover { background: rgba(88, 166, 255, 0.12); color: #58a6ff; }
    .tree-item.active { background: rgba(88, 166, 255, 0.2); border-color: #58a6ff; color: #ffffff; font-weight: 600; }
    .tree-item-title { display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-badge { font-size: 10px; padding: 2px 6px; border-radius: 10px; background: rgba(255,255,255,0.1); color: #8b949e; }
    .tree-item.active .tree-badge { background: #58a6ff; color: #0d1117; font-weight: bold; }

    /* Chế độ Sổ Giáo Trình / Danh Sách Thẻ (Outline Cards View) */
    #outline-view {
      position: absolute; top: 68px; left: 16px; right: 16px; bottom: 16px;
      background: #0d1117; z-index: 80; overflow-y: auto;
      padding: 16px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1);
      display: none; flex-direction: column; gap: 20px;
    }
    #outline-view.visible { display: flex; }
    .outline-card {
      background: #161b22; border: 1px solid rgba(88, 166, 255, 0.25);
      border-radius: 10px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .outline-card-header {
      background: rgba(88, 166, 255, 0.12); padding: 10px 16px;
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid rgba(88, 166, 255, 0.2);
    }
    .outline-card-title { font-size: 15px; font-weight: 700; color: #58a6ff; display: flex; align-items: center; gap: 8px; }
    .outline-card-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .outline-preview-wrap { width: 100%; max-height: 420px; background: #000; border-radius: 8px; overflow: hidden; display: flex; justify-content: center; align-items: center; }
    .outline-preview-canvas { max-width: 100%; height: auto; display: block; }

    /* Hướng dẫn góc dưới */
    .viewer-tips {
      position: absolute; bottom: 12px; left: 16px;
      background: rgba(13, 17, 23, 0.85); backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
      padding: 6px 12px; font-size: 11px; color: #8b949e; pointer-events: none; z-index: 50;
    }

    @media (max-width: 768px) {
      .viewer-header { padding: 8px 12px; }
      .hierarchy-sidebar { width: calc(100% - 32px); left: 16px; right: 16px; }
      .session-title { font-size: 13px; max-width: 140px; }
      .viewer-tips { display: none; }
    }
    @media print {
      .viewer-header, .breadcrumb-bar, .hierarchy-sidebar, .viewer-tips { display: none !important; }
      #outline-view { display: flex !important; position: static; overflow: visible; border: none; }
      .outline-card { break-inside: avoid; margin-bottom: 24px; border: 1px solid #000; background: #fff; color: #000; }
      .outline-card-title { color: #000; }
      body, html { overflow: visible; background: #fff; }
    }
  </style>
</head>
<body>
  <div id="viewer-container">
    <!-- Header -->
    <header class="viewer-header">
      <div class="brand-title" id="btn-brand">
        <span style="font-size: 20px;">📁</span>
        <div>
          <div class="session-title" id="title-text">Bài giảng</div>
          <div class="session-date" id="date-text">Xuất bản: vừa xong</div>
        </div>
      </div>
      <div class="viewer-actions">
        <button id="btn-toggle-sidebar" class="viewer-btn" title="Mở danh mục cây phân cấp bài giảng">
          🌳 Mục Lục Phân Cấp
        </button>
        <button id="btn-toggle-view" class="viewer-btn" title="Chuyển giữa Bản Đồ Canvas và Sổ Giáo Trình">
          📑 Sổ Giáo Trình
        </button>
        <select id="select-boards" class="board-select" title="Nhảy nhanh đến bảng con"></select>
        <button id="btn-zoom-fit" class="viewer-btn" title="Thu phóng vừa toàn bộ">🎯 Vừa màn hình</button>
        <button id="btn-zoom-reset" class="viewer-btn" title="Phóng chuẩn 100%">🔍 100%</button>
        <button id="btn-print" class="viewer-btn" title="In hoặc lưu file PDF">🖨️ In / PDF</button>
        <button id="btn-fullscreen" class="viewer-btn" title="Toàn màn hình">⛶</button>
      </div>
    </header>

    <!-- Breadcrumb -->
    <div class="breadcrumb-bar" id="breadcrumb-bar">
      <span class="breadcrumb-node" id="bc-root">🌍 Bảng Chính</span>
    </div>

    <!-- Canvas Map View -->
    <div id="canvas-wrap">
      <canvas id="viewer-canvas"></canvas>
      <div class="viewer-tips">💡 Kéo chuột/ngón tay để di chuyển • Lăn chuột hoặc chụm 2 ngón tay để Thu phóng • Bấm vào bảng để chọn</div>
    </div>

    <!-- Cây phân cấp Sidebar -->
    <aside class="hierarchy-sidebar hidden" id="hierarchy-sidebar">
      <div class="sidebar-header">
        <div class="sidebar-title">🌳 Phân Cấp Bài Giảng</div>
        <button class="sidebar-close" id="btn-close-sidebar">✕</button>
      </div>
      <input type="text" id="sidebar-search" class="sidebar-search" placeholder="🔍 Lọc bảng theo tên..." />
      <div class="tree-scroll" id="tree-list"></div>
    </aside>

    <!-- Chế độ Sổ Giáo Trình (Outline Cards View) -->
    <section id="outline-view"></section>
  </div>

  <script>
    const SESSION_DATA = ${JSON.stringify(sessionData)};

    const canvas = document.getElementById('viewer-canvas');
    const ctx = canvas.getContext('2d');
    const selectBoards = document.getElementById('select-boards');
    const breadcrumbBar = document.getElementById('breadcrumb-bar');
    const hierarchySidebar = document.getElementById('hierarchy-sidebar');
    const treeList = document.getElementById('tree-list');
    const outlineView = document.getElementById('outline-view');
    const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    const btnToggleView = document.getElementById('btn-toggle-view');
    const sidebarSearch = document.getElementById('sidebar-search');

    document.getElementById('title-text').textContent = SESSION_DATA.meta?.name || 'Bài giảng';
    document.getElementById('date-text').textContent = 'Xuất bản: ' + (SESSION_DATA.exportedAt || '');

    const BOARD_THEMES = {
      chalkboard: { bg: '#0d1f18', border: '#2e5b47', headerBg: '#122b22', text: '#58d68d', name: 'Phấn Xanh', icon: '🟢' },
      whiteboard: { bg: '#f8fafc', border: '#cbd5e1', headerBg: '#e2e8f0', text: '#0f172a', name: 'Bảng Trắng', icon: '🏢' },
      blueprint: { bg: '#0a192f', border: '#1d3557', headerBg: '#06101e', text: '#64ffda', name: 'Kỹ Thuật', icon: '📐' },
      midnight: { bg: '#06080c', border: '#1e293b', headerBg: '#0f172a', text: '#f0f6fc', name: 'Đen OLED', icon: '🌌' },
      default: { bg: '#161b22', border: '#30363d', headerBg: '#21262d', text: '#58a6ff', name: 'Mặc Định', icon: '📑' },
    };

    // 1. Phân tích cấu trúc phân cấp cây bài giảng (Tree Hierarchy Analysis)
    function analyzeHierarchy(rootNode) {
      const flatBoards = [];
      let totalStrokes = 0;

      function traverse(node, parentMatrix = { tx: 0, ty: 0, sx: 1, sy: 1 }, level = 0, path = []) {
        if (!node) return null;
        const isRoot = level === 0;
        const tr = node.transform || {};
        const ntx = tr.tx ?? tr.x ?? 0;
        const nty = tr.ty ?? tr.y ?? 0;

        const worldTx = isRoot ? 0 : parentMatrix.tx + ntx * parentMatrix.sx;
        const worldTy = isRoot ? 0 : parentMatrix.ty + nty * parentMatrix.sy;
        const worldSx = isRoot ? 1 : parentMatrix.sx * (tr.a ?? 1);
        const worldSy = isRoot ? 1 : parentMatrix.sy * (tr.d ?? 1);

        const w = (node.width || 800) * worldSx;
        const h = (node.height || 600) * worldSy;

        const currentPath = [...path, { id: node.id, name: isRoot ? 'Toàn bộ Bảng Chính' : (node.name || 'Bảng con') }];
        const elements = node.elements || node.strokes || [];
        const strokeCount = elements.length;
        totalStrokes += strokeCount;

        const boardItem = {
          id: node.id,
          name: isRoot ? 'Toàn bộ Bảng Chính' : (node.name || 'Bảng con'),
          isRoot,
          level,
          style: node.style || 'chalkboard',
          strokeCount,
          path: currentPath,
          width: node.width || 800,
          height: node.height || 600,
          worldX: worldTx,
          worldY: worldTy,
          worldW: w,
          worldH: h,
          bounds: {
            minX: isRoot ? Infinity : worldTx,
            minY: isRoot ? Infinity : worldTy,
            maxX: isRoot ? -Infinity : worldTx + w,
            maxY: isRoot ? -Infinity : worldTy + h,
          },
          children: [],
          node,
        };

        if (isRoot) {
          for (const s of elements) {
            for (const p of s.points || []) {
              if (p.x < boardItem.bounds.minX) boardItem.bounds.minX = p.x;
              if (p.y < boardItem.bounds.minY) boardItem.bounds.minY = p.y;
              if (p.x > boardItem.bounds.maxX) boardItem.bounds.maxX = p.x;
              if (p.y > boardItem.bounds.maxY) boardItem.bounds.maxY = p.y;
            }
          }
        }

        flatBoards.push(boardItem);

        const cZoom = !isRoot ? (node.contentZoom || 1) : 1;
        const cPanX = !isRoot ? (node.contentPan?.x || 0) : 0;
        const cPanY = !isRoot ? (node.contentPan?.y || 0) : 0;

        const innerMatrix = !isRoot
          ? { tx: worldTx - cPanX * worldSx, ty: worldTy - cPanY * worldSy, sx: worldSx * cZoom, sy: worldSy * cZoom }
          : { tx: 0, ty: 0, sx: 1, sy: 1 };

        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            const childItem = traverse(child, innerMatrix, level + 1, currentPath);
            if (childItem) {
              boardItem.children.push(childItem);
              if (isFinite(childItem.bounds.minX)) {
                boardItem.bounds.minX = Math.min(boardItem.bounds.minX, childItem.bounds.minX);
                boardItem.bounds.minY = Math.min(boardItem.bounds.minY, childItem.bounds.minY);
                boardItem.bounds.maxX = Math.max(boardItem.bounds.maxX, childItem.bounds.maxX);
                boardItem.bounds.maxY = Math.max(boardItem.bounds.maxY, childItem.bounds.maxY);
              }
            }
          }
        }

        return boardItem;
      }

      const rootItem = traverse(rootNode, { tx: 0, ty: 0, sx: 1, sy: 1 }, 0, []);
      return { rootItem, flatBoards, totalStrokes };
    }

    const sceneRoot = SESSION_DATA.content?.scene?.root || { id: 'root', name: 'World Canvas', children: [] };
    const hierarchy = analyzeHierarchy(sceneRoot);

    // 2. Trạng thái Camera & Lựa chọn bảng
    let camera = {
      zoom: 1.0,
      pan: { x: 0, y: 0 }
    };
    let activeBoardId = null;
    let isOutlineView = false;

    // 3. Xây dựng giao diện Sidebar Cây phân cấp & Select
    function buildHierarchyUI() {
      selectBoards.innerHTML = '';
      treeList.innerHTML = '';

      for (const b of hierarchy.flatBoards) {
        // Option dropdown
        const opt = document.createElement('option');
        opt.value = b.id;
        const indentStr = b.level > 0 ? '   '.repeat(b.level) + '└─ ' : '';
        opt.textContent = indentStr + (b.isRoot ? '🌍 Bảng Chính' : ('📑 ' + b.name + ' (' + b.strokeCount + ' nét)'));
        selectBoards.appendChild(opt);

        // Sidebar Tree item
        const item = document.createElement('div');
        item.className = 'tree-item' + (b.id === activeBoardId ? ' active' : '');
        item.dataset.id = b.id;
        item.style.paddingLeft = (10 + (b.level || 0) * 16) + 'px';

        const themeInfo = BOARD_THEMES[b.style] || BOARD_THEMES.chalkboard;
        const icon = b.isRoot ? '🌍' : (themeInfo.icon || '📑');
        const levelTag = b.level > 0 ? ('<span style="opacity:0.4;font-size:11px;margin-right:2px">' + '├─'.repeat(Math.min(1, b.level)) + '</span>') : '';

        item.innerHTML =
          '<div class="tree-item-title">' +
            levelTag + icon + ' <span>' + b.name + '</span>' +
          '</div>' +
          '<span class="tree-badge">' + b.strokeCount + ' nét</span>';

        item.onclick = () => focusBoard(b.id);
        treeList.appendChild(item);
      }
    }

    // 4. Cập nhật thanh Breadcrumb
    function updateBreadcrumbs(boardItem) {
      breadcrumbBar.innerHTML = '';
      if (!boardItem || boardItem.isRoot) {
        breadcrumbBar.innerHTML = '<span class="breadcrumb-node" onclick="focusBoard(hierarchy.flatBoards[0].id)">🌍 Toàn bộ Bảng Chính</span>';
        return;
      }
      boardItem.path.forEach((p, idx) => {
        if (idx > 0) {
          const sep = document.createElement('span');
          sep.className = 'breadcrumb-sep';
          sep.textContent = '›';
          breadcrumbBar.appendChild(sep);
        }
        const nodeSpan = document.createElement('span');
        nodeSpan.className = 'breadcrumb-node';
        nodeSpan.textContent = p.name;
        nodeSpan.onclick = () => focusBoard(p.id);
        breadcrumbBar.appendChild(nodeSpan);
      });
    }

    // 5. Điều hướng & Zoom vào bảng
    function focusBoard(boardId) {
      activeBoardId = boardId;
      selectBoards.value = boardId;

      // Cập nhật trạng thái active trên sidebar
      document.querySelectorAll('.tree-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === boardId);
      });

      const target = hierarchy.flatBoards.find(b => b.id === boardId) || hierarchy.flatBoards[0];
      updateBreadcrumbs(target);

      if (target.isRoot) {
        zoomToFit();
        return;
      }

      // Zoom căn khít bảng mục tiêu
      const padding = 70;
      const bW = target.worldW || 800;
      const bH = target.worldH || 600;
      const scaleX = (window.innerWidth - padding * 2) / bW;
      const scaleY = (window.innerHeight - padding * 2) / bH;
      camera.zoom = Math.min(scaleX, scaleY, 2.5);

      const cx = target.worldX + bW / 2;
      const cy = target.worldY + bH / 2;
      camera.pan.x = window.innerWidth / 2 - cx * camera.zoom;
      camera.pan.y = window.innerHeight / 2 - cy * camera.zoom;
      render();
    }

    function zoomToFit() {
      activeBoardId = hierarchy.flatBoards[0]?.id || null;
      updateBreadcrumbs(hierarchy.flatBoards[0]);

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const b of hierarchy.flatBoards) {
        if (isFinite(b.bounds.minX)) {
          minX = Math.min(minX, b.bounds.minX);
          minY = Math.min(minY, b.bounds.minY);
          maxX = Math.max(maxX, b.bounds.maxX);
          maxY = Math.max(maxY, b.bounds.maxY);
        }
      }

      if (!isFinite(minX)) {
        camera.zoom = 1; camera.pan = { x: window.innerWidth / 2 - 400, y: window.innerHeight / 2 - 300 };
        render();
        return;
      }

      const padding = 80;
      const bW = Math.max(200, maxX - minX);
      const bH = Math.max(200, maxY - minY);
      camera.zoom = Math.min((window.innerWidth - padding * 2) / bW, (window.innerHeight - padding * 2) / bH, 1.5);
      const cx = minX + bW / 2;
      const cy = minY + bH / 2;
      camera.pan.x = window.innerWidth / 2 - cx * camera.zoom;
      camera.pan.y = window.innerHeight / 2 - cy * camera.zoom;
      render();
    }

    // 6. VẼ CANVAS ĐỆ QUY CHUẨN XÁC VỚI SCISSOR CLIPPING (Không đè nét, phân cấp tuyệt đối)
    function render() {
      const dpr = window.devicePixelRatio || 1;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      // Nền đen vũ trụ
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

      // Lưới tọa độ nhẹ
      const gridSize = 40 * camera.zoom;
      if (gridSize > 12) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
        const startX = (camera.pan.x % gridSize);
        const startY = (camera.pan.y % gridSize);
        for (let x = startX; x < window.innerWidth; x += gridSize) {
          for (let y = startY; y < window.innerHeight; y += gridSize) {
            ctx.fillRect(x, y, 1.5, 1.5);
          }
        }
      }

      ctx.save();
      ctx.translate(camera.pan.x, camera.pan.y);
      ctx.scale(camera.zoom, camera.zoom);

      // Hàm vẽ đệ quy từng Node (Vẽ container -> Clip -> Nét vẽ -> Bảng con)
      function renderNodeRecursive(node, isRoot = true) {
        ctx.save();

        if (!isRoot) {
          const tx = node.transform?.tx ?? 0;
          const ty = node.transform?.ty ?? 0;
          ctx.translate(tx, ty);

          const theme = BOARD_THEMES[node.style] || BOARD_THEMES.chalkboard;
          const isActive = activeBoardId && node.id === activeBoardId;

          // Đổ bóng (Shadow)
          ctx.shadowColor = isActive ? 'rgba(88, 166, 255, 0.5)' : 'rgba(0, 0, 0, 0.4)';
          ctx.shadowBlur = (isActive ? 24 : 12) / camera.zoom;
          ctx.shadowOffsetY = 4 / camera.zoom;

          // Khung bảng
          ctx.fillStyle = theme.bg;
          ctx.strokeStyle = isActive ? '#58a6ff' : theme.border;
          ctx.lineWidth = (isActive ? 3 : 1.5) / camera.zoom;

          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(0, 0, node.width, node.height, 8);
          } else {
            ctx.rect(0, 0, node.width, node.height);
          }
          ctx.fill();
          ctx.stroke();

          // Reset shadow
          ctx.shadowColor = 'transparent';

          // Header Bar
          const headerH = 32;
          ctx.fillStyle = isActive ? 'rgba(88, 166, 255, 0.25)' : theme.headerBg;
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(0, 0, node.width, headerH, [8, 8, 0, 0]);
          } else {
            ctx.rect(0, 0, node.width, headerH);
          }
          ctx.fill();

          // Đường phân cách header
          ctx.strokeStyle = theme.border;
          ctx.lineWidth = 1 / camera.zoom;
          ctx.beginPath();
          ctx.moveTo(0, headerH);
          ctx.lineTo(node.width, headerH);
          ctx.stroke();

          // Tiêu đề bảng
          ctx.fillStyle = isActive ? '#58a6ff' : theme.text;
          ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText((node.name || 'Bảng con'), 12, headerH * 0.5);

          // SCISSOR CLIPPING: Giới hạn nét vẽ CHỈ nằm trong mặt bảng bên dưới Header
          ctx.beginPath();
          ctx.rect(0, headerH, node.width, Math.max(0, node.height - headerH));
          ctx.clip();

          // Áp dụng Pan/Zoom nội bộ của bảng con
          const zoom = node.contentZoom || 1.0;
          const panX = node.contentPan?.x || 0;
          const panY = node.contentPan?.y || 0;
          ctx.translate(-panX, -panY);
          ctx.scale(zoom, zoom);
        }

        // Vẽ nét vẽ thuộc về bảng này (Local coordinates hoàn hảo)
        const elements = node.elements || node.strokes || [];
        for (const s of elements) {
          if (!Array.isArray(s.points) || s.points.length === 0) continue;
          ctx.beginPath();
          ctx.strokeStyle = s.color || '#ffffff';
          ctx.lineWidth = s.baseWidth || 3;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          if (s.points.length === 1) {
            ctx.arc(s.points[0].x, s.points[0].y, (s.baseWidth || 3) / 2, 0, Math.PI * 2);
            ctx.fillStyle = s.color || '#ffffff';
            ctx.fill();
          } else {
            ctx.moveTo(s.points[0].x, s.points[0].y);
            for (let i = 1; i < s.points.length; i++) {
              ctx.lineTo(s.points[i].x, s.points[i].y);
            }
            ctx.stroke();
          }
        }

        // Vẽ văn bản ghi chú OCR nếu có
        if (node.textContent) {
          ctx.fillStyle = '#f0f6fc';
          ctx.font = '15px sans-serif';
          ctx.textBaseline = 'top';
          ctx.fillText(node.textContent, 20, 50);
        }

        // Đệ quy vẽ bảng con lồng nhau
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            renderNodeRecursive(child, false);
          }
        }

        ctx.restore();
      }

      renderNodeRecursive(sceneRoot, true);

      ctx.restore();

      // Thông báo nếu chưa có nội dung
      if (hierarchy.totalStrokes === 0 && hierarchy.flatBoards.length <= 1) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('📝 Bài giảng này hiện chưa có bảng con hoặc nét vẽ nào.', window.innerWidth / 2, window.innerHeight / 2 - 10);
        ctx.font = '13px sans-serif';
        ctx.fillStyle = '#6e7681';
        ctx.fillText('Hãy mở phần mềm NestedCanvas để bắt đầu tạo các bảng bài giảng.', window.innerWidth / 2, window.innerHeight / 2 + 18);
        ctx.textAlign = 'start';
      }

      ctx.restore();
    }

    // 7. Chế độ Sổ Giáo Trình (Outline Cards View)
    function buildOutlineView() {
      outlineView.innerHTML = '';
      const nonRootBoards = hierarchy.flatBoards.filter(b => !b.isRoot);

      if (nonRootBoards.length === 0) {
        outlineView.innerHTML = '<div style="text-align:center;padding:60px 20px;color:#8b949e">Bài giảng chưa tạo bảng con nào. Bạn có thể xem trên chế độ Bản Đồ Canvas.</div>';
        return;
      }

      for (const b of nonRootBoards) {
        const theme = BOARD_THEMES[b.style] || BOARD_THEMES.chalkboard;
        const card = document.createElement('div');
        card.className = 'outline-card';

        const pathStr = b.path.map(function(p) { return p.name; }).join(' › ');
        card.innerHTML =
          '<div class="outline-card-header">' +
            '<div class="outline-card-title">' +
              '<span>' + theme.icon + ' ' + b.name + '</span>' +
              '<span style="font-size:11px;font-weight:normal;opacity:0.6;margin-left:8px">Cấp ' + b.level + ' • ' + b.strokeCount + ' nét</span>' +
            '</div>' +
            '<button class="viewer-btn btn-open-canvas">🎯 Mở trên Canvas</button>' +
          '</div>' +
          '<div class="outline-card-body">' +
            '<div style="font-size:12px;color:#8b949e">📂 Đường dẫn: <b style="color:#58a6ff">' + pathStr + '</b></div>' +
            '<div class="outline-preview-wrap">' +
              '<canvas id="preview-' + b.id + '" class="outline-preview-canvas" width="' + b.width + '" height="' + b.height + '"></canvas>' +
            '</div>' +
          '</div>';
        outlineView.appendChild(card);

        const btnOpen = card.querySelector('.btn-open-canvas');
        if (btnOpen) {
          btnOpen.onclick = () => openOnCanvas(b.id);
        }

        // Vẽ nội dung bảng con lên preview canvas
        setTimeout(() => {
          const pCanvas = document.getElementById('preview-' + b.id);
          if (!pCanvas) return;
          const pCtx = pCanvas.getContext('2d');
          pCtx.fillStyle = theme.bg;
          pCtx.fillRect(0, 0, b.width, b.height);

          // Header
          pCtx.fillStyle = theme.headerBg;
          pCtx.fillRect(0, 0, b.width, 32);
          pCtx.fillStyle = theme.text;
          pCtx.font = 'bold 14px sans-serif';
          pCtx.fillText(b.name, 12, 21);

          // Strokes với Scissor Clipping & Pan/Zoom
          const cZoom = b.node.contentZoom || 1.0;
          const cPanX = b.node.contentPan?.x || 0;
          const cPanY = b.node.contentPan?.y || 0;

          pCtx.save();
          pCtx.beginPath();
          pCtx.rect(0, 32, b.width, Math.max(0, b.height - 32));
          pCtx.clip();
          pCtx.translate(-cPanX, -cPanY);
          pCtx.scale(cZoom, cZoom);

          const elements = b.node.elements || b.node.strokes || [];
          for (const s of elements) {
            if (!Array.isArray(s.points) || s.points.length === 0) continue;
            pCtx.beginPath();
            pCtx.strokeStyle = s.color || '#ffffff';
            pCtx.lineWidth = s.baseWidth || 3;
            pCtx.lineCap = 'round';
            pCtx.lineJoin = 'round';
            if (s.points.length === 1) {
              pCtx.arc(s.points[0].x, s.points[0].y, (s.baseWidth || 3)/2, 0, Math.PI * 2);
              pCtx.fillStyle = s.color || '#ffffff';
              pCtx.fill();
            } else {
              pCtx.moveTo(s.points[0].x, s.points[0].y);
              for (let i = 1; i < s.points.length; i++) pCtx.lineTo(s.points[i].x, s.points[i].y);
              pCtx.stroke();
            }
          }
          pCtx.restore();
        }, 50);
      }
    }

    window.openOnCanvas = function(boardId) {
      if (isOutlineView) toggleView();
      focusBoard(boardId);
    };

    function toggleView() {
      isOutlineView = !isOutlineView;
      outlineView.classList.toggle('visible', isOutlineView);
      btnToggleView.classList.toggle('active', isOutlineView);
      btnToggleView.textContent = isOutlineView ? '🎨 Bản Đồ Canvas' : '📑 Sổ Giáo Trình';
      if (isOutlineView) buildOutlineView();
    }

    // 8. Tương tác Chuột & Cảm ứng trên Canvas
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialPinchDist = 0;
    let initialPinchZoom = 1;

    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX - camera.pan.x;
      startY = e.clientY - camera.pan.y;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      camera.pan.x = e.clientX - startX;
      camera.pan.y = e.clientY - startY;
      render();
    });

    window.addEventListener('mouseup', () => { isDragging = false; });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.88;
      const mouseX = e.clientX;
      const mouseY = e.clientY;
      const newZoom = Math.max(0.05, Math.min(15.0, camera.zoom * zoomFactor));
      camera.pan.x = mouseX - (mouseX - camera.pan.x) * (newZoom / camera.zoom);
      camera.pan.y = mouseY - (mouseY - camera.pan.y) * (newZoom / camera.zoom);
      camera.zoom = newZoom;
      render();
    }, { passive: false });

    // Cảm ứng Touch / Pinch Zoom
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        isDragging = true;
        startX = e.touches[0].clientX - camera.pan.x;
        startY = e.touches[0].clientY - camera.pan.y;
      } else if (e.touches.length === 2) {
        isDragging = false;
        initialPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        initialPinchZoom = camera.zoom;
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      if (isDragging && e.touches.length === 1) {
        camera.pan.x = e.touches[0].clientX - startX;
        camera.pan.y = e.touches[0].clientY - startY;
        render();
      } else if (e.touches.length === 2 && initialPinchDist > 0) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const factor = dist / initialPinchDist;
        camera.zoom = Math.max(0.05, Math.min(15.0, initialPinchZoom * factor));
        render();
      }
    }, { passive: true });

    canvas.addEventListener('touchend', () => {
      isDragging = false;
      initialPinchDist = 0;
    });

    // Bấm chọn bảng trên Canvas
    canvas.addEventListener('click', (e) => {
      const worldX = (e.clientX - camera.pan.x) / camera.zoom;
      const worldY = (e.clientY - camera.pan.y) / camera.zoom;

      // Tìm bảng con sâu nhất chứa điểm click
      for (let i = hierarchy.flatBoards.length - 1; i >= 1; i--) {
        const b = hierarchy.flatBoards[i];
        if (worldX >= b.worldX && worldX <= b.worldX + b.worldW && worldY >= b.worldY && worldY <= b.worldY + b.worldH) {
          focusBoard(b.id);
          return;
        }
      }
    });

    // 9. Các nút điều khiển
    btnToggleSidebar.onclick = () => {
      const isHidden = hierarchySidebar.classList.toggle('hidden');
      btnToggleSidebar.classList.toggle('active', !isHidden);
    };
    document.getElementById('btn-close-sidebar').onclick = () => {
      hierarchySidebar.classList.add('hidden');
      btnToggleSidebar.classList.remove('active');
    };
    btnToggleView.onclick = toggleView;
    selectBoards.onchange = () => focusBoard(selectBoards.value);
    document.getElementById('btn-zoom-fit').onclick = zoomToFit;
    document.getElementById('btn-zoom-reset').onclick = () => {
      camera.zoom = 1.0;
      render();
    };
    document.getElementById('btn-print').onclick = () => {
      if (!isOutlineView) toggleView();
      setTimeout(() => window.print(), 300);
    };
    document.getElementById('btn-fullscreen').onclick = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    };
    sidebarSearch.oninput = () => {
      const q = sidebarSearch.value.trim().toLowerCase();
      document.querySelectorAll('.tree-item').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
      });
    };

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      render();
    }
    window.addEventListener('resize', resize);

    // Khởi chạy
    buildHierarchyUI();
    resize();
    zoomToFit();
  </script>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }
