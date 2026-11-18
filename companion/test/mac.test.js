// macOS port: the channel to the native app, the silent voice's registration,
// the Keychain-encrypted keys, finding the game, and the native sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { PREFIX, startShellChannel } from '../src/mac-shell.js';
import { mergePath } from '../src/mac-path.js';
import { parsePluginkit } from '../src/mac-voice.js';
import { aesOpen, aesSeal, isSealed, revealSecrets, sealSecrets, setSecretProtector } from '../src/secrets.js';
import { MAC_WOW_PROCESS, looksLikeFlavorDir, normalizeWowDir } from '../src/detect.js';
import { bundlePath } from '../src/app/system.js';
import { ROOT } from '../src/config.js';

function channel(handlers = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = [];
  output.on('data', (d) => sent.push(...String(d).split('\n').filter(Boolean)));
  const ch = startShellChannel({ input, output, ...handlers });
  return { ch, input, sent };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('the native app and the service talk line by line', async () => {
  const calls = [];
  const { ch, input, sent } = channel({
    onOpen: () => calls.push('open'),
    onClosed: () => calls.push('closed'),
    onChoice: (c, r) => calls.push(`choice:${c}:${r}`),
    onQuit: () => calls.push('quit'),
  });
  await tick();
  assert.ok(sent[0].startsWith(`${PREFIX}texts `), 'the texts go first, in the app language');
  ch.notify('Title\nwith newline', 'Body\twith tab');
  ch.ask();
  await tick();
  assert.ok(sent.includes(`${PREFIX}notify Title with newline\tBody with tab`));
  assert.ok(sent.includes(`${PREFIX}ask`));
  input.write('open\nclosed\nchoice tray 1\n');
  await tick();
  assert.deepEqual(calls, ['open', 'closed', 'choice:tray:true']);

  // A dialog: the answer comes back with its id, base64.
  const picked = ch.request('pick-folder', 'Choose the folder');
  await tick();
  const ask = sent.find((l) => l.startsWith(`${PREFIX}pick-folder `)).split(' ');
  assert.equal(Buffer.from(ask[3], 'base64').toString(), 'Choose the folder');
  input.write(`picked ${ask[2]} ${Buffer.from('/Applications/World of Warcraft').toString('base64')}\n`);
  assert.equal(await picked, '/Applications/World of Warcraft');
  const cancelled = ch.request('pick-file', 'x');
  await tick();
  const id = sent.filter((l) => l.startsWith(`${PREFIX}pick-file `)).pop().split(' ')[2];
  input.write(`picked ${id} -\n`);
  assert.equal(await cancelled, null);

  // The app went away: the service quits with it.
  input.end();
  await tick();
  assert.equal(calls.at(-1), 'quit');
});

test('stopping the channel on purpose does not count as the app quitting', async () => {
  const calls = [];
  const { ch } = channel({ onQuit: () => calls.push('quit') });
  ch.stop();
  await tick();
  assert.deepEqual(calls, []);
});

test('the terminal PATH is merged with the usual folders, without repeats', () => {
  assert.equal(mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin', ['/x', '/bin']), '/usr/bin:/bin:/opt/homebrew/bin:/x');
  assert.equal(mergePath('', undefined, []), '');
});

test('pluginkit\'s list of the silent voice is read, with the player\'s choice', () => {
  const out = [
    '+    io.github.nullgatestudios.ForeverAICompanion.Voice(1.11.0)\t8152BD7F-6E3D-4A00-B531-5598B2D0E45B\t2026-11-16 14:02:59 +0000\t/Users/me/Applications/Forever AI Companion.app/Contents/PlugIns/ForeverAICompanionVoice.appex',
    '-    io.github.nullgatestudios.ForeverAICompanion.Voice(1.10.0)\t11111111-6E3D-4A00-B531-5598B2D0E45B\t2026-11-10 10:00:00 +0000\t/Users/me/Downloads/Forever AI Companion.app/Contents/PlugIns/ForeverAICompanionVoice.appex',
    '     com.other.Thing(2.0)\t22222222-6E3D-4A00-B531-5598B2D0E45B\t2026-11-10 10:00:00 +0000\t/Applications/Other.app/Contents/PlugIns/X.appex',
    ' (3 plug-ins)',
  ].join('\n');
  const list = parsePluginkit(out);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], {
    election: '+', id: 'io.github.nullgatestudios.ForeverAICompanion.Voice', version: '1.11.0',
    path: '/Users/me/Applications/Forever AI Companion.app/Contents/PlugIns/ForeverAICompanionVoice.appex',
  });
  assert.equal(list[1].election, '-');
  assert.equal(list[2].election, '');
});

test('macOS: API keys are sealed with the Keychain key (AES-256-GCM)', (t) => {
  const key = Buffer.alloc(32, 7);
  const blob = aesSeal(key, 'sk-ant-secret');
  assert.equal(aesOpen(key, blob), 'sk-ant-secret');
  assert.equal(aesOpen(Buffer.alloc(32, 8), blob), null, 'another key reads nothing');
  const tampered = Buffer.from(blob, 'base64');
  tampered[tampered.length - 1] ^= 1;
  assert.equal(aesOpen(key, tampered.toString('base64')), null, 'a changed blob is refused');

  // The same flow as DPAPI, stored as { keychain: … }.
  const fake = {
    field: 'keychain',
    protect: (values) => values.map((v) => aesSeal(key, v)),
    unprotect: (blobs) => blobs.map((b) => aesOpen(key, b)),
  };
  setSecretProtector(fake);
  t.after(() => setSecretProtector(null));
  const sealed = sealSecrets({ keys: { claude: 'sk-ant-1' } });
  assert.ok(typeof sealed.keys.claude.keychain === 'string');
  assert.ok(isSealed(sealed.keys.claude));
  assert.equal(revealSecrets(sealed).cfg.keys.claude, 'sk-ant-1');
  assert.ok(isSealed({ dpapi: 'x' }), 'Windows blobs are still recognized');
});

test('macOS: the game is found in its app folder, and seen running', () => {
  assert.ok(MAC_WOW_PROCESS.test('/Applications/World of Warcraft/_forever_/World of Warcraft.app/Contents/MacOS/World of Warcraft'));
  assert.ok(!MAC_WOW_PROCESS.test('/Applications/Battle.net.app/Contents/MacOS/Battle.net'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-macwow-'));
  try {
    const forever = path.join(root, 'World of Warcraft', '_forever_');
    fs.mkdirSync(path.join(forever, 'World of Warcraft.app'), { recursive: true });
    assert.ok(looksLikeFlavorDir(forever));
    assert.equal(normalizeWowDir(path.join(root, 'World of Warcraft')), forever);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the service knows the app bundle it runs from', () => {
  assert.equal(bundlePath('/Users/me/Applications/Forever AI Companion.app/Contents/MacOS/ForeverAICompanionService'),
    '/Users/me/Applications/Forever AI Companion.app');
  assert.equal(bundlePath('/usr/local/bin/node'), null);
});

test('every macOS text of the app window replaces an existing one', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'app', 'ui.html'), 'utf8');
  const keysOf = (block) => [...block.matchAll(/^\s*'([\w.]+)':/gm)].map((m) => m[1]);
  const mac = html.slice(html.indexOf('const I18N_MAC = {'), html.indexOf('let isMacUI'));
  const base = html.slice(html.indexOf('const I18N = {'), html.indexOf('const I18N_MAC = {'));
  const baseKeys = new Set(keysOf(base));
  const macKeys = keysOf(mac);
  assert.ok(macKeys.length > 20);
  for (const k of macKeys) assert.ok(baseKeys.has(k), `${k} exists in the Windows texts`);
});

test('the macOS native sources compile', { skip: process.platform !== 'darwin' || !hasSwift() }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-swift-'));
  try {
    const src = path.join(ROOT, 'macos');
    execFileSync('swiftc', ['-typecheck', '-target', 'arm64-apple-macos13.0', path.join(src, 'App.swift')], { stdio: 'pipe' });
    execFileSync('swiftc', ['-typecheck', '-target', 'arm64-apple-macos13.0', '-parse-as-library', '-application-extension',
      '-module-name', 'ForeverAICompanionVoice', path.join(src, 'Voice.swift')], { stdio: 'pipe' });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

function hasSwift() {
  try { execFileSync('swiftc', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
