// System integration for the packaged app: install location, shortcuts,
// start with Windows / open at login, opening the window, folder picker,
// uninstall. Windows and macOS.
//
// On macOS the app is a bundle ("Forever AI Companion.app"): its native part
// (macos/App.swift) shows the menu bar icon, the window and the dialogs, and
// runs this program (the service) with a line channel to it (see shell
// below and main.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import * as sea from 'node:sea';
import { fileURLToPath } from 'node:url';
import { APP_ID, LEGACY_NAME, envVar, roamingDir } from '../config.js';
import { err, t } from '../i18n.js';

// Name players see (window, shortcuts, messages, start with Windows).
export const DISPLAY_NAME = 'Forever AI Companion';
export const EXE_NAME = 'ForeverAICompanion.exe';
// Internal id: the data and install folders.
export const APP_NAME = APP_ID;
// The project's previous name: its data and install folders, its first exe,
// shortcut and "start with Windows" entry, moved away from by main.js.
const LEGACY_SHORTCUT = `${LEGACY_NAME}.lnk`;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ForeverAICompanion';

export const isPackaged = () => {
  try { return sea.isSea(); } catch { return false; }
};
export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const APP_BUNDLE = `${DISPLAY_NAME}.app`;
export const BUNDLE_ID = 'io.github.nullgatestudios.ForeverAICompanion';

const programsDir = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs');
// macOS: the user's own Applications folder (no administrator needed).
const userApplications = () => path.join(os.homedir(), 'Applications');
export const appDataDir = () => path.join(roamingDir(), APP_NAME);
// FAIC_INSTALL_DIR: a test install somewhere else; then nothing machine-wide
// is touched (start with Windows, the previous name's folders).
export const isSandbox = () => Boolean(envVar('INSTALL_DIR'));
export const installDir = () => envVar('INSTALL_DIR') || (isMac ? userApplications() : path.join(programsDir(), APP_NAME));
export const installedExe = () => path.join(installDir(), EXE_NAME);

// --- macOS app bundle --------------------------------------------------------
// The bundle this program runs from (…/Forever AI Companion.app), or null
// (development). The service is Contents/MacOS/ForeverAICompanionService.
export function bundlePath(exe = process.execPath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe);
  return m ? m[1] : null;
}
export const installedBundle = () => path.join(installDir(), APP_BUNDLE);
// Installed: in ~/Applications or /Applications (where players drag apps).
export function isInstalledBundle(bundle = bundlePath()) {
  if (!bundle) return false;
  const parent = path.dirname(bundle);
  return samePath(parent, installDir()) || samePath(parent, '/Applications');
}
// The native part of the bundle (macos/App.swift). In development, the one in
// a bundle built by `npm run build` (dist/mac), when there is one.
export function nativeHelper() {
  const bundle = bundlePath() || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '..', 'dist', 'mac', APP_BUNDLE);
  const exe = path.join(bundle, 'Contents', 'MacOS', 'ForeverAICompanion');
  return isMac && fs.existsSync(exe) ? exe : null;
}
// Runs the native helper with arguments: its output (trimmed), or throws.
export function runNative(args, { timeout = 30000 } = {}) {
  const exe = nativeHelper();
  if (!exe) return Promise.reject(new Error('the app bundle was not found'));
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e && !stdout) reject(new Error((stderr || e.message).trim()));
      else resolve(String(stdout || '').trim());
    });
  });
}

// The line channel to the native app (macOS), set by main.js when the
// service was started by it. null otherwise (development, Windows).
let shell = null;
export const setShell = (s) => { shell = s; };
export const getShell = () => shell;
export const legacyAppDataDir = () => path.join(roamingDir(), LEGACY_NAME);
export const legacyInstallDir = () => path.join(programsDir(), LEGACY_NAME);

export const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Runs a command, resolving to { ok, stdout, stderr } (never throws).
export function exec(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: 60000, ...opts }, (e, stdout, stderr) => {
      resolve({ ok: !e, code: e?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// AppleScript (macOS). Values go in as arguments, never into the script text.
export async function osascript(lines, args = [], timeout = 600000) {
  const r = await exec('/usr/bin/osascript', [...lines.flatMap((l) => ['-e', l]), ...args], { timeout });
  if (!r.ok) throw new Error(r.stderr.trim() || 'osascript failed');
  return r.stdout.trim();
}

// Runs a PowerShell script. Values go in through environment variables so
// paths with quotes or accents never need escaping.
export function powershell(script, { vars = {}, sta = false, timeout = 120000 } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (sta) args.push('-STA');
  args.push('-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`);
  const envVars = { ...process.env };
  for (const [k, v] of Object.entries(vars)) envVars[`FAIC_${k}`] = String(v);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { env: envVars, windowsHide: true, timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

const SHORTCUT_PS = `
$folder = [Environment]::GetFolderPath($env:FAIC_FOLDER)
$old = Join-Path $folder $env:FAIC_LEGACY
if (Test-Path $old) { Remove-Item $old -Force }
$lnk = Join-Path $folder ($env:FAIC_NAME + '.lnk')
# A brand-new shortcut file (not an edited one) makes Explorer read the icon again.
if (Test-Path $lnk) { Remove-Item $lnk -Force }
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = $env:FAIC_TARGET
$s.WorkingDirectory = Split-Path $env:FAIC_TARGET
$s.IconLocation = $env:FAIC_TARGET + ',0'
$s.Description = $env:FAIC_NAME + ': AI assistant for WoW Forever'
$s.Save()`;

// Windows caches program icons by path: after an update it keeps showing the
// old one. This tells Explorer the files changed and refreshes the cache.
const REFRESH_ICONS_PS = `
Add-Type -Namespace Faic -Name Shell -MemberDefinition '[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern void SHChangeNotify(int e, uint f, string a, System.IntPtr b);'
foreach ($p in ($env:FAIC_PATHS -split '\\|')) { if ($p -and (Test-Path $p)) { [Faic.Shell]::SHChangeNotify(0x00002000, 0x0005, $p, [IntPtr]::Zero) } }
[Faic.Shell]::SHChangeNotify(0x08000000, 0, $null, [IntPtr]::Zero)
$ie = Join-Path $env:SystemRoot 'System32\\ie4uinit.exe'
if (Test-Path $ie) { Start-Process $ie -ArgumentList '-show' -WindowStyle Hidden -Wait }`;

export async function refreshIcons(paths) {
  await powershell(REFRESH_ICONS_PS, { vars: { PATHS: paths.join('|') } });
}

export async function createShortcuts(target) {
  if (envVar('NO_SHORTCUTS') || isMac) return; // tests; on macOS the app is in Applications
  for (const folder of ['Programs', 'Desktop']) {
    await powershell(SHORTCUT_PS, { vars: { FOLDER: folder, TARGET: target, NAME: DISPLAY_NAME, LEGACY: LEGACY_SHORTCUT } });
  }
  await refreshIcons([target]).catch(() => {});
}

export async function removeShortcuts() {
  if (isMac) return;
  await powershell(`
foreach ($f in 'Programs','Desktop') {
  foreach ($n in @(($env:FAIC_NAME + '.lnk'), $env:FAIC_LEGACY)) {
    $p = Join-Path ([Environment]::GetFolderPath($f)) $n
    if (Test-Path $p) { Remove-Item $p -Force }
  }
}`, { vars: { NAME: DISPLAY_NAME, LEGACY: LEGACY_SHORTCUT } });
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: stdout || '' }));
  });
}

// macOS: a login item of the app (System Settings > General > Login Items),
// registered by its native part. "approval": the player has to allow it there.
async function macLoginItem(mode) {
  const out = await runNative(['--login-item', mode]);
  return out === 'on' ? true : out === 'approval' ? true : false;
}

export async function getAutostart() {
  if (isMac) {
    if (!isPackaged() || isSandbox() || !bundlePath()) return null;
    try { return await macLoginItem('status'); } catch { return null; }
  }
  if (!isWindows || !isPackaged() || isSandbox()) return null;
  const { ok } = await reg(['query', RUN_KEY, '/v', RUN_VALUE]);
  if (ok) return true;
  return (await reg(['query', RUN_KEY, '/v', LEGACY_NAME])).ok; // entry from before the rename
}

export async function setAutostart(enabled) {
  if (isMac) {
    if (!isPackaged() || isSandbox() || !bundlePath()) throw err('installedOnly');
    return macLoginItem(enabled ? 'on' : 'off');
  }
  if (!isWindows || !isPackaged() || isSandbox()) throw err('installedOnly');
  await reg(['delete', RUN_KEY, '/v', LEGACY_NAME, '/f']); // entry from before the rename
  if (enabled) {
    await reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${process.execPath}" --background`, '/f']);
  } else {
    await reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  }
  return getAutostart();
}

function detached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
  child.on('error', () => {});
  child.unref();
}

// Opens the UI in an app-style Edge window (no tabs/address bar) when
// available, otherwise in the default browser.
export function openWindow(url) {
  if (isMac && shell) {
    shell.send(`url ${url}`);
    shell.send('window');
    return;
  }
  if (!isWindows) {
    detached(isMac ? 'open' : 'xdg-open', [url]);
    return;
  }
  const edge = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((p) => fs.existsSync(p));
  if (edge) detached(edge, [`--app=${url}`, '--window-size=1000,860']);
  else detached('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
}

// macOS: opens a URL with the system (System Settings pages, websites).
export function openUrl(url) {
  detached(isMac ? '/usr/bin/open' : 'xdg-open', [url]);
}

export function openFolder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  detached(isWindows ? 'explorer.exe' : 'open', [dir]);
}

// macOS: the native app's dialog, or AppleScript's in development.
async function macPick(kind, title) {
  if (shell) {
    const p = await shell.request(kind, title);
    return p || null;
  }
  const what = kind === 'pick-folder' ? 'choose folder' : 'choose file';
  try {
    return await osascript([
      'on run argv',
      `try`,
      `return POSIX path of (${what} with prompt (item 1 of argv))`,
      'on error number -128',
      'return ""',
      'end try',
      'end run',
    ], [title]) || null;
  } catch {
    return null;
  }
}

export async function pickFolder() {
  if (isMac) return macPick('pick-folder', t('pickFolder'));
  if (!isWindows) throw err('typePath');
  const out = await powershell(`
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${t('pickFolder').replace(/'/g, "''")}'
$d.ShowNewFolderButton = $false
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }`, { sta: true, timeout: 600000 });
  return out || null;
}

// Windows "Open file" dialog. Returns the chosen path or null.
export async function pickFile({ title = '', filter = 'All files (*.*)|*.*' } = {}) {
  if (isMac) return macPick('pick-file', title);
  if (!isWindows) throw err('typePath');
  const out = await powershell(`
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = $env:FAIC_TITLE
$d.Filter = $env:FAIC_FILTER
$d.CheckFileExists = $true
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }`, { sta: true, timeout: 600000, vars: { TITLE: title, FILTER: filter } });
  return out || null;
}

export async function showError(message) {
  if (isMac) {
    if (shell) { shell.send(`alert ${Buffer.from(message, 'utf8').toString('base64')}`); return; }
    try {
      await osascript(['on run argv', 'display alert (item 1 of argv) message (item 2 of argv) as critical', 'end run'], [DISPLAY_NAME, message], 120000);
    } catch { /* nothing else we can do */ }
    return;
  }
  if (!isWindows) return;
  try {
    await powershell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show($env:FAIC_MSG, $env:FAIC_NAME, 'OK', 'Error') | Out-Null`, { vars: { MSG: message, NAME: DISPLAY_NAME } });
  } catch { /* nothing else we can do */ }
}

// Deletes the install folder a few seconds after this process exits
// (macOS: the app bundle, once the app has quit).
export function scheduleSelfDelete(dir) {
  if (isMac) {
    const bundle = bundlePath();
    if (!bundle) return;
    afterShellQuits(`rm -rf "$1"`, [bundle]);
    return;
  }
  const cmd = `/d /s /c "ping -n 4 127.0.0.1 >nul & rmdir /s /q "${dir}""`;
  spawn('cmd.exe', [cmd], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
}

export function relaunch(exe, args = []) {
  if (isMac) {
    // exe: an app bundle, opened once this app has quit. Without -n: macOS
    // never starts a second copy of an app that is already open.
    afterShellQuits('/usr/bin/open "$1" --args "${@:2}"', [exe, ...args]);
    return;
  }
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
}

// macOS: runs a shell snippet once this app (the native part, or this
// process in development) has exited. Values go in as $1, $2…
export function afterShellQuits(script, args = []) {
  const pid = shell ? process.ppid : process.pid;
  const wait = `pid=${Number(pid)}; i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done; sleep 0.3; `;
  spawn('/bin/bash', ['-c', wait + script, 'faic', ...args], { detached: true, stdio: 'ignore' }).unref();
}

// macOS: copies an app bundle (keeping its signature intact) and lets it run
// without Gatekeeper asking again: the player already opened this copy.
export async function copyBundle(from, to) {
  const tmp = `${to}.new-${Date.now()}`;
  const r = await exec('/usr/bin/ditto', [from, tmp], { timeout: 300000 });
  if (!r.ok) throw new Error(r.stderr.trim() || 'ditto failed');
  await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', tmp]);
  if (fs.existsSync(to)) {
    const old = `${to}.old-${Date.now()}`;
    fs.renameSync(to, old);
    afterShellQuits('rm -rf "$1"', [old]);
  }
  fs.renameSync(tmp, to);
  // Tells macOS about the app (and its silent voice extension) right away.
  await exec('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', to]);
}
