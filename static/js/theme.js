// theme.js — Chirm theming system
// Layer order (each overrides the previous):
//   1. CSS :root defaults (app.css)
//   2. Server default palette (from public-settings API, stored as theme_css_vars JSON)
//   3. User custom theme (localStorage chirm_user_theme)

export const COLOR_GROUPS = [
  {
    label: 'Backgrounds',
    vars: [
      { key: '--bg-void',     label: 'Void (page bg)' },
      { key: '--bg-base',     label: 'Base (chat area)' },
      { key: '--bg-sidebar',  label: 'Sidebar' },
      { key: '--bg-surface',  label: 'Surface (messages)' },
      { key: '--bg-elevated', label: 'Elevated (modals)' },
      { key: '--bg-input',    label: 'Input fields' },
    ],
  },
  {
    label: 'Accent',
    vars: [
      { key: '--accent',       label: 'Primary accent' },
      { key: '--accent-hover', label: 'Accent (hover)' },
      { key: '--accent-text',  label: 'Accent text' },
    ],
  },
  {
    label: 'Text',
    vars: [
      { key: '--text-primary',   label: 'Primary text' },
      { key: '--text-secondary', label: 'Secondary text' },
      { key: '--text-muted',     label: 'Muted / timestamps' },
      { key: '--text-link',      label: 'Links' },
    ],
  },
  {
    label: 'Status',
    vars: [
      { key: '--success', label: 'Success / Online' },
      { key: '--danger',  label: 'Danger / Error' },
      { key: '--warning', label: 'Warning / Idle' },
    ],
  },
];

export const COLOR_VARS = COLOR_GROUPS.flatMap(g => g.vars.map(v => v.key));

export const THEME_PRESETS = [
  {
    name: 'Chirm Default',
    vars: {
      '--bg-void': '#09090c', '--bg-base': '#0f1117', '--bg-sidebar': '#13151e',
      '--bg-surface': '#181b26', '--bg-elevated': '#1e2130',
      '--bg-input': '#0d0f18',
      '--accent': '#7c6af5', '--accent-hover': '#9180ff', '--accent-text': '#a89bf7',
      '--text-primary': '#e8eaf0', '--text-secondary': '#9196a8',
      '--text-muted': '#5a5f72', '--text-link': '#7c9ef5',
      '--success': '#3fba7a', '--danger': '#e05252', '--warning': '#e0a030',
    },
  },
  {
    name: 'Midnight Blue',
    vars: {
      '--bg-void': '#070b12', '--bg-base': '#0b1220', '--bg-sidebar': '#0e1628',
      '--bg-surface': '#131d30', '--bg-elevated': '#19253a',
      '--bg-input': '#080f1a',
      '--accent': '#4a80f0', '--accent-hover': '#6090ff', '--accent-text': '#7aaeff',
      '--text-primary': '#dde4f0', '--text-secondary': '#8898b8',
      '--text-muted': '#4a5570', '--text-link': '#5c9ef5',
      '--success': '#3ab873', '--danger': '#e04848', '--warning': '#d99020',
    },
  },
  {
    name: 'Emerald Night',
    vars: {
      '--bg-void': '#070c0a', '--bg-base': '#0c1410', '--bg-sidebar': '#0f1814',
      '--bg-surface': '#141f1a', '--bg-elevated': '#1a2820',
      '--bg-input': '#090e0c',
      '--accent': '#2ec27a', '--accent-hover': '#40d88e', '--accent-text': '#5ae0a0',
      '--text-primary': '#ddeee6', '--text-secondary': '#7aaa90',
      '--text-muted': '#456050', '--text-link': '#50d090',
      '--success': '#30c870', '--danger': '#e05050', '--warning': '#d99020',
    },
  },
  {
    name: 'Warm Slate',
    vars: {
      '--bg-void': '#0c0b0a', '--bg-base': '#151412', '--bg-sidebar': '#1a1917',
      '--bg-surface': '#201e1c', '--bg-elevated': '#272422',
      '--bg-input': '#0f0e0d',
      '--accent': '#e07845', '--accent-hover': '#f08a55', '--accent-text': '#f0a070',
      '--text-primary': '#ece8e4', '--text-secondary': '#a09890',
      '--text-muted': '#605850', '--text-link': '#c09050',
      '--success': '#4ab870', '--danger': '#e05050', '--warning': '#d9a020',
    },
  },
];

export function applyVars(vars) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
}

export function loadServerTheme(settings) {
  try {
    const raw = settings?.theme_css_vars;
    if (!raw) return;
    applyVars(JSON.parse(raw));
  } catch {}
}

export function loadUserTheme() {
  try {
    const raw = localStorage.getItem('chirm_user_theme');
    if (!raw) return;
    applyVars(JSON.parse(raw));
  } catch {}
}

export function saveUserTheme(vars) {
  try {
    localStorage.setItem('chirm_user_theme', JSON.stringify(vars));
  } catch {}
}

export function resetUserTheme() {
  localStorage.removeItem('chirm_user_theme');
  COLOR_VARS.forEach(v => document.documentElement.style.removeProperty(v));
  const pubSettings = window.App?.publicSettings;
  if (pubSettings) loadServerTheme(pubSettings);
}

// ── Custom preset management (localStorage, per-browser) ─────────────────────

const CUSTOM_PRESETS_KEY = 'chirm_custom_presets';

export function getCustomPresets() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '[]');
  } catch { return []; }
}

export function saveCustomPreset(name, vars) {
  const presets = getCustomPresets().filter(p => p.name !== name);
  presets.push({ name, vars });
  try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets)); } catch {}
}

export function deleteCustomPreset(name) {
  const presets = getCustomPresets().filter(p => p.name !== name);
  try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets)); } catch {}
}

export function getAllPresets() {
  return [
    ...THEME_PRESETS.map(p => ({ ...p, builtin: true })),
    ...getCustomPresets().map(p => ({ ...p, builtin: false })),
  ];
}

const ChirmTheme = {
  COLOR_GROUPS, COLOR_VARS, THEME_PRESETS,
  applyVars, loadServerTheme, loadUserTheme, saveUserTheme, resetUserTheme,
  getCustomPresets, saveCustomPreset, deleteCustomPreset, getAllPresets,
};

export default ChirmTheme;
