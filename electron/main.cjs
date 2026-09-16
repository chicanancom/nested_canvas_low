const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { fork } = require('child_process');

let mainWindow = null;
let staticServer = null;
let syncProcess = null;

async function ensureSyncServerRunning() {
  const isSyncUp = await checkUrlActive('http://127.0.0.1:8765/health');
  if (!isSyncUp) {
    try {
      const syncServerScript = path.join(__dirname, '../server/sync_server.js');
      if (fs.existsSync(syncServerScript)) {
        console.log('[Electron PC Display] Launching background Sync Server on port 8765...');
        syncProcess = fork(syncServerScript, [], { stdio: 'inherit' });
      }
    } catch (e) {
      console.warn('[Electron PC Display] Could not auto-launch sync server:', e.message);
    }
  }
}

// Khởi tạo Static Server cục bộ siêu nhẹ nếu Vite dev server chưa bật
function startLocalStaticServer(distDir, port = 3100) {
  return new Promise((resolve) => {
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
    };

    const server = http.createServer((req, res) => {
      let reqPath = req.url.split('?')[0];
      if (reqPath === '/' || reqPath === '') reqPath = '/display.html';

      const filePath = path.join(distDir, reqPath);
      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          // fallback to display.html for SPA routes
          const fallback = path.join(distDir, 'display.html');
          fs.readFile(fallback, (fErr, content) => {
            if (fErr) {
              res.writeHead(404);
              res.end('Not Found');
            } else {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(content);
            }
          });
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
      });
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        startLocalStaticServer(distDir, port + 1).then(resolve);
      } else {
        console.warn('[StaticServer] Error:', e.message);
        resolve(null);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[Electron PC Display] Local server active at http://127.0.0.1:${port}`);
      resolve(port);
    });

    staticServer = server;
  });
}

function checkUrlActive(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      resolve(res.statusCode < 400 || res.statusCode === 404);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(600, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: true,
    autoHideMenuBar: true,
    title: 'NestedCanvas PC Fullscreen Display',
    backgroundColor: '#090d13',
    icon: path.join(__dirname, '../android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Chuyển tiếp log từ màn chiếu ra terminal để dễ theo dõi
  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`[Display Window] ${message}`);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.warn(`[Display Window] ⚠️ Load failed: ${errorCode} - ${errorDescription}`);
  });

  const isViteUp = await checkUrlActive('http://localhost:3000/display.html');

  if (isViteUp) {
    console.log('[Electron PC Display] Connecting to active Vite dev server (http://localhost:3000)...');
    mainWindow.loadURL('http://localhost:3000/display.html');
  } else {
    const distDir = path.join(__dirname, '../dist');
    const port = await startLocalStaticServer(distDir, 3100);
    if (port) {
      mainWindow.loadURL(`http://127.0.0.1:${port}/display.html`);
    } else {
      mainWindow.loadFile(path.join(distDir, 'display.html'));
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await ensureSyncServerRunning();
  createWindow();

  // Đăng ký phím tắt toàn cục
  globalShortcut.register('F11', () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  globalShortcut.register('Escape', () => {
    if (mainWindow && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
  });

  globalShortcut.register('CommandOrControl+R', () => {
    if (mainWindow) {
      mainWindow.reload();
    }
  });

  const clearDisplayCache = async () => {
    if (mainWindow) {
      try {
        await mainWindow.webContents.executeJavaScript(`
          localStorage.removeItem('nestedcanvas_display_mirror_state');
          const app = window.pcDisplayApp || window.displayApp;
          if (app) {
            if (typeof app.clearDisplayState === 'function') app.clearDisplayState();
            if (app.syncClient && app.syncClient.isConnected) {
              app.syncClient.send('CANVAS_CLEAR', {});
            }
          }
          location.reload();
        `);
      } catch (e) {
        mainWindow.reload();
      }
    }
  };

  globalShortcut.register('CommandOrControl+Shift+Delete', clearDisplayCache);
  globalShortcut.register('CommandOrControl+Shift+Backspace', clearDisplayCache);

  globalShortcut.register('F12', () => {
    if (mainWindow) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  globalShortcut.register('CommandOrControl+Alt+I', () => {
    if (mainWindow) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (staticServer) {
    try {
      staticServer.close();
    } catch (e) {}
  }
  if (syncProcess) {
    try {
      syncProcess.kill();
    } catch (e) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
