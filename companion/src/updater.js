// Updates from inside the app: checks the project's latest GitHub release,
// downloads ForeverAICompanion.exe (macOS: ForeverAICompanion-mac.zip) and
// checks it (size, SHA-256 published by GitHub, Windows executable / zip).
// Installing it on Windows is just running it: the new exe closes this one,
// replaces it in the install folder and starts (see app/main.js selfInstall),
// keeping all data. On macOS see mac-update.js.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REPO = 'nullgatestudios/forever-ai-companion';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const WINDOWS_ASSET = 'ForeverAICompanion.exe';
export const MAC_ASSET = 'ForeverAICompanion-mac.zip';
export const assetName = (platform = process.platform) => (platform === 'darwin' ? MAC_ASSET : WINDOWS_ASSET);
export const ASSET_NAME = assetName();
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const MAX_BYTES = 400 * 1024 * 1024;

// "1.10.0" > "1.9.2"; a leading "v" is ignored. Pre-releases are not offered.
export function compareVersions(a, b) {
  const parse = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// What the app needs from GitHub's "latest release" answer, or null.
// `allowUrl` decides which download addresses are trusted.
export function parseRelease(json, { allowUrl = (u) => u.startsWith(DOWNLOAD_PREFIX), platform = process.platform } = {}) {
  if (!json || json.draft || json.prerelease || !json.tag_name) return null;
  const asset = (json.assets || []).find((a) => a.name === assetName(platform));
  if (!asset || !allowUrl(String(asset.browser_download_url || ''))) return null;
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
  return {
    version: String(json.tag_name).replace(/^v/i, ''),
    notesUrl: json.html_url || `https://github.com/${REPO}/releases/latest`,
    url: asset.browser_download_url,
    size: Number(asset.size) || null,
    sha256: digest ? digest[1].toLowerCase() : null,
  };
}

// Checks every few hours. state() feeds the app window; onAvailable(version)
// is called once per new version (tray notice).
export function createUpdater({
  currentVersion, dir, log = () => {}, fetchImpl = fetch, apiUrl = RELEASES_API,
  allowUrl, intervalMs = 6 * 3600000, onAvailable = () => {}, platform = process.platform,
}) {
  const mac = platform === 'darwin';
  const state = { status: 'idle', current: currentVersion, latest: null, notesUrl: null, progress: 0, error: null, checkedAt: null };
  let release = null;
  let ready = null; // path of a verified download
  let checking = null;
  let downloading = null;
  let announced = null;

  // Old downloads (the update already installed or replaced by a newer one).
  try {
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
  } catch { /* no folder yet */ }

  function check() {
    if (checking) return checking;
    if (state.status === 'downloading') return Promise.resolve(state);
    checking = (async () => {
      state.status = 'checking';
      state.error = null;
      try {
        const res = await fetchImpl(apiUrl, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'ForeverAICompanion' },
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 404) throw new Error('no releases published');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const found = parseRelease(await res.json(), allowUrl ? { allowUrl, platform } : { platform });
        state.checkedAt = new Date().toISOString();
        if (!found || compareVersions(found.version, currentVersion) <= 0) {
          release = null;
          state.status = 'latest';
          state.latest = found?.version || currentVersion;
          return state;
        }
        if (release?.version !== found.version) ready = null;
        release = found;
        Object.assign(state, { status: ready ? 'ready' : 'available', latest: found.version, notesUrl: found.notesUrl });
        if (announced !== found.version) {
          announced = found.version;
          log(`Update available: ${found.version}`);
          onAvailable(found.version);
        }
      } catch (e) {
        state.status = release ? (ready ? 'ready' : 'available') : 'error';
        state.error = e.message;
        log(`Could not check for updates: ${e.message}`);
      } finally {
        checking = null;
      }
      return state;
    })();
    return checking;
  }

  // Downloads and verifies the new exe. Returns its path.
  function download() {
    if (ready && fs.existsSync(ready)) return Promise.resolve(ready);
    if (downloading) return downloading;
    if (!release) return Promise.reject(new Error('no update available'));
    const rel = release;
    downloading = (async () => {
      state.status = 'downloading';
      state.progress = 0;
      state.error = null;
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `ForeverAICompanion-${rel.version}${mac ? '-mac.zip' : '.exe'}`);
      const tmp = `${target}.part`;
      try {
        const res = await fetchImpl(rel.url, { headers: { 'user-agent': 'ForeverAICompanion' }, signal: AbortSignal.timeout(15 * 60000) });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || rel.size || 0;
        const hash = crypto.createHash('sha256');
        const out = fs.openSync(tmp, 'w');
        let got = 0;
        let head = null;
        try {
          for await (const chunk of res.body) {
            const buf = Buffer.from(chunk);
            if (!head) head = buf.subarray(0, 2);
            got += buf.length;
            if (got > MAX_BYTES) throw new Error('the download is too large');
            hash.update(buf);
            fs.writeSync(out, buf);
            if (total) state.progress = Math.min(99, Math.floor((got / total) * 100));
          }
        } finally {
          fs.closeSync(out);
        }
        if (rel.size && got !== rel.size) throw new Error(`incomplete download (${got} of ${rel.size} bytes)`);
        if (mac) {
          if (!head || head.toString('latin1') !== 'PK') throw new Error('the download is not a zip file');
        } else if (!head || head.toString('latin1') !== 'MZ') throw new Error('the download is not a Windows program');
        const sha = hash.digest('hex');
        if (rel.sha256 && sha !== rel.sha256) throw new Error('the download does not match the published file (SHA-256)');
        fs.renameSync(tmp, target);
        ready = target;
        state.progress = 100;
        state.status = 'ready';
        log(`Update ${rel.version} downloaded and verified${rel.sha256 ? ' (SHA-256)' : ''}.`);
        return target;
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        state.status = 'available';
        state.error = e.message;
        log(`Update download failed: ${e.message}`);
        throw e;
      } finally {
        downloading = null;
      }
    })();
    return downloading;
  }

  const first = setTimeout(() => check(), 15000);
  const timer = setInterval(() => check(), intervalMs);
  first.unref?.();
  timer.unref?.();

  return {
    check,
    download,
    state: () => ({ ...state }),
    stop() { clearTimeout(first); clearInterval(timer); },
  };
}
