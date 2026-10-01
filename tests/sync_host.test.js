import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../src/sync/client.js';

function resolveHost({ search = '', hostname = '192.168.1.36', port = '3000', native = false, saved = '192.168.1.121' } = {}) {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  try {
    globalThis.window = {
      location: { search, hostname, port, protocol: 'http:' },
      Capacitor: { isNativePlatform: () => native },
    };
    globalThis.localStorage = { getItem: () => saved, setItem() {} };
    return SyncClient.prototype._resolveDefaultHost();
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
}
test('LAN browser follows the computer serving the web page despite an old stored IP', () => {
  assert.equal(resolveHost(), '192.168.1.36');
});
test('explicit server parameter still overrides browser host', () => {
  assert.equal(resolveHost({ search: '?server=192.168.1.50' }), '192.168.1.50');
});
test('native app keeps manually saved server address', () => {
  assert.equal(resolveHost({ native: true, hostname: 'localhost', port: '' }), '192.168.1.121');
});
test('PC browser localhost uses its local sync server', () => {
  assert.equal(resolveHost({ hostname: 'localhost' }), 'localhost');
});
