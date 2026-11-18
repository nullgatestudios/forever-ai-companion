// macOS invisible sending: the silent "ForeverAICompanion" voice
// (macos/Voice.swift) is a speech synthesis provider extension inside the
// app bundle (Contents/PlugIns). macOS lists its voice to every program, WoW
// included, once the extension is registered: no administrator permission
// and nothing installed outside the app. Turning it off leaves a flag file the
// extension reads (it then offers no voice); uninstalling the app removes it.
import fs from 'node:fs';
import path from 'node:path';
import { APP_ID, roamingDir } from './config.js';
import { VOICE_NAME } from './tts-voice.js';
import { bundlePath, exec, nativeHelper, runNative } from './app/system.js';

export const VOICE_EXTENSION_ID = 'io.github.nullgatestudios.ForeverAICompanion.Voice';
// Read by the extension (macos/Voice.swift): while it exists, no voice is offered.
export const voiceOffFlag = () => path.join(roamingDir(), APP_ID, 'voice-off');
const PLUGINKIT = '/usr/bin/pluginkit';

// The extension inside this app (or the development bundle in dist/mac).
export function voiceExtensionPath() {
  const exe = nativeHelper();
  const bundle = bundlePath() || (exe ? path.resolve(exe, '..', '..', '..') : null);
  const appex = bundle && path.join(bundle, 'Contents', 'PlugIns', 'ForeverAICompanionVoice.appex');
  return appex && fs.existsSync(appex) ? appex : null;
}

// `pluginkit -m -v -i <id>` lines: "+    <id>(1.0)  <uuid>  <date>  <path>".
// The first column is the player's choice: "+" use, "-" ignore, " " none.
export function parsePluginkit(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([+\-=!?])?\s*(\S+)\((.*?)\)\s+\S+\s+.+?\s+(\/.+?)\s*$/.exec(line);
    if (m) out.push({ election: m[1] || '', id: m[2], version: m[3], path: m[4] });
  }
  return out;
}

async function registrations() {
  const r = await exec(PLUGINKIT, ['-m', '-v', '-i', VOICE_EXTENSION_ID], { timeout: 20000 });
  return parsePluginkit(r.stdout).filter((p) => p.id === VOICE_EXTENSION_ID);
}

// The voices the game can list (as AVSpeechSynthesizer lists them).
export async function macVoices() {
  try {
    return JSON.parse(await runNative(['--voices'], { timeout: 30000 }) || '[]');
  } catch {
    return [];
  }
}

export const isOurVoice = (v) => typeof v?.name === 'string' && v.name.startsWith(VOICE_NAME);

export async function macVoiceStatus() {
  const appex = voiceExtensionPath();
  if (!appex) return { supported: false, active: false };
  const [regs, voices, screen] = await Promise.all([
    registrations(), macVoices(), runNative(['--screen-access', 'check']).catch(() => 'unknown'),
  ]);
  const ours = regs.find((r) => path.resolve(r.path) === path.resolve(appex));
  return {
    supported: true,
    active: voices.some(isOurVoice) && !fs.existsSync(voiceOffFlag()),
    registered: Boolean(ours),
    legacy: false,
    // Permission for the on-screen line (the other way to send questions).
    screen,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Registers this app's extension (dropping copies of the app elsewhere, like
// the one opened from Downloads) and makes macOS list the voice.
export async function enableMacVoice({ log = () => {} } = {}) {
  const appex = voiceExtensionPath();
  if (!appex) throw new Error('the silent voice is not in this app');
  fs.rmSync(voiceOffFlag(), { force: true });
  for (const r of await registrations()) {
    if (path.resolve(r.path) !== path.resolve(appex)) await exec(PLUGINKIT, ['-r', r.path]);
  }
  await exec(PLUGINKIT, ['-a', appex]);
  await exec(PLUGINKIT, ['-e', 'use', '-i', VOICE_EXTENSION_ID]);
  await runNative(['--refresh-voices']).catch(() => {});
  for (let i = 0; i < 20; i++) {
    if ((await macVoices()).some(isOurVoice)) {
      log('Invisible voice enabled.');
      return true;
    }
    await sleep(500);
  }
  log('The silent voice was registered but macOS does not list it yet.');
  return false;
}

export async function disableMacVoice({ log = () => {} } = {}) {
  fs.mkdirSync(path.dirname(voiceOffFlag()), { recursive: true });
  fs.writeFileSync(voiceOffFlag(), 'Invisible sending is off (Forever AI Companion).\n');
  await runNative(['--refresh-voices']).catch(() => {});
  for (let i = 0; i < 10 && (await macVoices()).some(isOurVoice); i++) await sleep(500);
  log('Invisible voice disabled.');
}

// Uninstalling the app: macOS forgets the extension.
export async function removeMacVoice() {
  for (const r of await registrations()) await exec(PLUGINKIT, ['-r', r.path]);
  await runNative(['--refresh-voices']).catch(() => {});
}

// The on-screen line needs the Screen Recording permission: asks for it.
export async function requestScreenAccess() {
  return runNative(['--screen-access', 'request'], { timeout: 120000 }).catch(() => 'unknown');
}
