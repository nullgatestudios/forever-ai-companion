import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { revealSecrets, sealSecrets, secretsProtected } from './secrets.js';

// Folder of the companion source (dev mode). In the packaged app this is unused.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Internal id: data and install folders, the in-game addon, the silent voice.
export const APP_ID = 'ForeverAICompanion';
export const ADDON_NAME = APP_ID;
export const ADDON_SRC = path.resolve(ROOT, '..', 'addon', ADDON_NAME);
// The project's previous name, still found on PCs that had version 1.5.0 or
// older (addon folders, saved variables, data and install folders). Only used
// to migrate those installs.
export const LEGACY_NAME = 'AzerothIA';

// Where config.json, state.json, knowledge/ and logs live.
// Dev: the companion folder. Packaged app: %APPDATA%\ForeverAICompanion on
// Windows, ~/Library/Application Support/ForeverAICompanion on macOS (see app/main.js).
export const env = { dataDir: ROOT };

// %APPDATA% (Windows) or ~/Library/Application Support (macOS): the packaged
// app's data folder and the silent voice's inbox live there.
export const roamingDir = () => (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));

// Settings from environment variables (FAIC_*). The AZIA_* spelling from
// before the rename still works.
export const envVar = (name) => process.env[`FAIC_${name}`] || process.env[`AZIA_${name}`] || '';

// Published guide: the same file as knowledge-builtin/wow-forever.md, read from
// the project's public repository. Editing it there updates every player.
export const GUIDE_URL = 'https://raw.githubusercontent.com/nullgatestudios/forever-ai-companion/main/companion/knowledge-builtin/wow-forever.md';

export const DEFAULTS = {
  // WoW Forever folder (the one that contains Interface/ and Screenshots/).
  // null = detect it. The FAIC_WOW_DIR variable also works.
  wowDir: null,

  // "anthropic" | "openai" | "claude-code" | "codex" | "echo"
  provider: 'echo',

  anthropic: {
    model: 'claude-opus-5-5',
    effort: 'low',
    maxTokens: 2000,
    apiKey: null, // null = use ANTHROPIC_API_KEY
    fallbacks: true,
  },
  // Any OpenAI-compatible API: OpenAI, Gemini, Ollama, LM Studio, OpenRouter...
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    apiKey: null, // null = use the apiKeyEnv variable
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  // model: "sonnet" | "opus" | "haiku" | "default" (the plan's default) or a full model id.
  claudeCode: { bin: 'claude', model: 'sonnet', effort: 'low', extraArgs: [] },
  // Codex CLI with a ChatGPT Plus / Pro plan. model: "default" (the plan's) or a slug.
  codex: { bin: 'codex', model: 'default', effort: 'low', extraArgs: [] },

  // Set by the app window: "claude" | "chatgpt" | "gemini" | "ollama" | "claude-code" | "codex" | "echo".
  // When set, it overrides provider/anthropic/openai above (see PRESETS).
  preset: null,
  keys: {},
  models: {},

  slots: 50,
  signals: 500,
  pollMs: 1000,
  keepAnswers: 30,
  timeoutMs: 180000,

  // Let the AI search the web when it needs to (Claude, Codex).
  webSearch: true,

  // Where the up-to-date WoW Forever guide is published (see src/guide.js).
  // The app downloads it every few hours; null = only the guide inside the app.
  guideUrl: GUIDE_URL,

  // Language of the app and its messages: "auto" (the system's language), "en" or "es".
  language: 'auto',

  // Closing the app window: "ask" | "tray" (keep running next to the clock /
  // in the menu bar) | "quit".
  closeAction: 'ask',

  // macOS: false when the player turned invisible sending off (the silent
  // voice ships inside the app and is on by default; see mac-voice.js).
  macVoice: true,
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export const configFile = () => path.join(env.dataDir, 'config.json');

export function readUserConfig(file = configFile()) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
}

// Simple choices shown in the app window. Each maps onto a provider config.
// The user's keys and models are stored per preset in `keys` / `models`.
export const PRESETS = {
  claude: { provider: 'anthropic', model: 'claude-opus-5-5', needsKey: true },
  chatgpt: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', needsKey: true },
  gemini: { provider: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needsKey: true },
  ollama: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false },
  'claude-code': { provider: 'claude-code', model: 'sonnet', needsKey: false },
  codex: { provider: 'codex', model: 'default', needsKey: false },
  echo: { provider: 'echo', needsKey: false },
};

export function applyPreset(cfg) {
  const p = PRESETS[cfg.preset];
  if (!p) return cfg;
  const key = cfg.keys?.[cfg.preset] || null;
  const model = cfg.models?.[cfg.preset] || p.model;
  cfg.provider = p.provider;
  if (p.provider === 'anthropic') {
    cfg.anthropic = { ...cfg.anthropic, apiKey: key, model };
  } else if (p.provider === 'openai') {
    cfg.openai = { ...cfg.openai, baseUrl: p.baseUrl, model, apiKey: key, apiKeyEnv: null };
  } else if (p.provider === 'claude-code') {
    cfg.claudeCode = { ...cfg.claudeCode, model };
  } else if (p.provider === 'codex') {
    cfg.codex = { ...cfg.codex, model };
  }
  return cfg;
}

function writeConfig(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// API keys are stored encrypted (Windows DPAPI, see secrets.js) and decrypted here.
export function loadConfig(file = configFile()) {
  const saved = readUserConfig(file);
  const { cfg: user, plainFound } = revealSecrets(saved);
  // Keys saved as plain text (earlier versions, or typed into config.json): encrypt them now.
  if (plainFound && secretsProtected()) {
    try { writeConfig(file, sealSecrets(saved)); } catch { /* left as is; retried on the next start */ }
  }
  const cfg = applyPreset(merge(DEFAULTS, user));
  if (envVar('WOW_DIR')) cfg.wowDir = envVar('WOW_DIR');
  if (envVar('PROVIDER')) cfg.provider = envVar('PROVIDER');
  return cfg;
}

// Merges `patch` into the saved user config (only what the user changed is
// stored). New keys are encrypted before they reach the disk; if that fails
// nothing is saved.
export function saveConfig(patch, file = configFile()) {
  const next = merge(readUserConfig(file), patch);
  writeConfig(file, sealSecrets(next));
  return loadConfig(file);
}

function candidateDirs() {
  const out = [];
  if (process.platform === 'win32') {
    for (const drive of ['C', 'D', 'E', 'F']) {
      for (const base of ['Program Files (x86)', 'Program Files', '', 'Games', 'Juegos']) {
        out.push(path.join(`${drive}:\\`, base, 'World of Warcraft', '_forever_'));
      }
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/World of Warcraft/_forever_');
    out.push(path.join(os.homedir(), 'Applications', 'World of Warcraft', '_forever_'));
  }
  return out;
}

export function resolveWowDir(cfg) {
  if (cfg.wowDir) {
    if (!fs.existsSync(cfg.wowDir)) throw new Error(`The configured WoW folder does not exist: ${cfg.wowDir}`);
    return cfg.wowDir;
  }
  const found = candidateDirs().find((d) => fs.existsSync(d));
  if (!found) {
    throw new Error(
      'WoW Forever folder not found. Set "wowDir" in config.json ' +
      '(the _forever_ folder that contains Interface and Screenshots).',
    );
  }
  return found;
}

// `name`: the addon's folder name. legacy() gives the same paths for the addon
// under the project's previous name (see install.js / inbox.js).
export function wowPaths(wowDir, name = ADDON_NAME) {
  const addons = path.join(wowDir, 'Interface', 'AddOns');
  const addonDir = path.join(addons, name);
  const pad = (n, w) => String(n).padStart(w, '0');
  return {
    wowDir,
    name,
    addons,
    addonDir,
    inboxGlobal: `${name}_Inbox`,
    screenshots: path.join(wowDir, 'Screenshots'),
    sigDir: path.join(addonDir, 'sig'),
    okSignal: path.join(addonDir, 'sig', 'ok.wav'),
    signal: (i) => path.join(addonDir, 'sig', `${pad(i, 3)}.wav`),
    slotName: (i) => `${name}_S${pad(i, 2)}`,
    slotDir: (i) => path.join(addons, `${name}_S${pad(i, 2)}`),
    legacy: name === ADDON_NAME ? () => wowPaths(wowDir, LEGACY_NAME) : null,
  };
}
