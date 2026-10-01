import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { uniqueSessionName } from '../src/storage/sessionNames.js';

test('new names stay readable and skip existing numbered names', () => {
  const sessions = ['Toán', 'Toán (2)', 'Toán (3)'].map(name => ({ name }));
  assert.equal(uniqueSessionName(' Toán ', sessions), 'Toán (4)');
  assert.equal(uniqueSessionName('Văn', sessions), 'Văn');
});
test('names differing only by case or Unicode encoding still get a suffix', () => {
  assert.equal(uniqueSessionName('toán', [{ name: 'TOÁN'.normalize('NFD') }]), 'toán (2)');
  assert.equal(uniqueSessionName('', [{ name: 'Bảng mới' }]), 'Bảng mới (2)');
});
test('creating repeated boards saves distinct names and preserves existing boards', async () => {
  const source = readFileSync(new URL('../src/storage/sessionManager.js', import.meta.url), 'utf8');
  const sessions = [{ meta: { id: 'existing', name: 'Toán' }, content: { marker: 'keep' } }];
  const db = {
    async getAllSessions() { return sessions.map(session => session.meta); },
    async saveSession(meta, content) { sessions.push({ meta, content }); },
  };
  const Manager = vm.runInNewContext(source.slice(source.indexOf('export class SessionManager')).replace('export class', 'class') + '\nSessionManager;', { db, uniqueSessionName, DEFAULT_EMPTY_THUMBNAIL: '' });
  const manager = new Manager();
  manager.switchSession = async id => sessions.find(session => session.meta.id === id);
  const first = await manager.createSession('Toán');
  const second = await manager.createSession('Toán');
  assert.equal(first.meta.name, 'Toán (2)');
  assert.equal(second.meta.name, 'Toán (3)');
  assert.equal(sessions[0].content.marker, 'keep');
});
