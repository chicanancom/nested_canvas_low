import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const address = process.argv[2];
if (!address) throw new Error('Usage: npm run build:apk:lan -- http://<LAN-IP>:3200');
const url = new URL(address);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
  throw new Error('Use an HTTP(S) frontend URL without credentials.');
}
if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname)) {
  throw new Error('Use the computer LAN address, not localhost (which refers to the phone).');
}
url.searchParams.set('server', url.hostname);
if (process.argv.includes('--diagnostics')) url.searchParams.set('diagnostics', '1');
const env = { ...process.env };
env.JAVA_HOME ||= '/opt/homebrew/opt/openjdk@17';
env.ANDROID_HOME ||= '/Users/macbook/Library/Android/sdk';
env.PATH = `${env.JAVA_HOME}/bin:${env.ANDROID_HOME}/platform-tools:${env.PATH}`;
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

run('npm', ['run', 'build']);
run('npx', ['--no-install', 'cap', 'sync', 'android']);
// Change only generated Android assets, restoring them even if Gradle fails.
const configPath = path.join(root, 'android/app/src/main/assets/capacitor.config.json');
const offlinePath = path.join(root, 'android/app/src/main/assets/public/lan-offline.html');
const originalConfig = readFileSync(configPath);
const originalOffline = existsSync(offlinePath) ? readFileSync(offlinePath) : null;
try {
  const config = JSON.parse(originalConfig);
  config.server = { ...config.server, url: url.href, cleartext: url.protocol === 'http:', errorPath: 'lan-offline.html' };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const template = readFileSync(new URL('./lan-offline.html', import.meta.url), 'utf8');
  writeFileSync(offlinePath, template.replaceAll('__SERVER_URL__', escapeHtml(url.href)));
  console.log(`Building LAN APK → ${url.href}`);
  run('./gradlew', ['assembleDebug'], path.join(root, 'android'));
  const outputDir = path.join(root, 'build-apk');
  mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, process.argv.includes('--diagnostics') ? 'nestedcanvas-lan-diagnostic.apk' : 'nestedcanvas-lan-debug.apk');
  copyFileSync(path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'), output);
  console.log(`APK: ${output}\nFrontend: ${url.href}\nRun npm run serve:lan and npm run sync on the computer.`);
} finally {
  writeFileSync(configPath, originalConfig);
  if (originalOffline) writeFileSync(offlinePath, originalOffline);
  else if (existsSync(offlinePath)) unlinkSync(offlinePath);
}
