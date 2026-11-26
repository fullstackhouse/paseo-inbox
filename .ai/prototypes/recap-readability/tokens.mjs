// tokens.css for an atlas of an app that is not Open Mercato.
//
// The engine (components.css, screens.css, prototype.css, prototype.js) reads a fixed set of
// CSS variables. This file maps the app's own design tokens onto that contract and also exposes
// the ramps under an app prefix (--app-*) for the surface styles at the end of screens.css.
//
// Fill the source: import the app's token module directly when it is TypeScript (Node strips
// types: `await import('../../src/theme/tokens.ts')`), or parse its CSS. Never re-type values.
// Then: node tokens.mjs && node <skill>/scripts/sync-tokens.mjs --verify .
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// ── 1. The app's tokens ─────────────────────────────────────────────────
// Example for a TypeScript token module:
//   const { colors, radius, shadow } = await import(path.resolve(here, '../../../src/ui/tokens.ts'))
// Paseo's Zinc dark theme (packages/app/src/styles/theme.ts, zincDarkColors + darkStatusColors),
// the theme in the reviewer's screenshot. The engine's light ramps get neutral zinc values; the
// panel itself reads only the --app-p-* extras.
const app = {
  white: '#ffffff',
  gray: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 900: '#18181b' },
  brand: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 500: '#71717a', 600: '#3f3f46', 700: '#27272a', 900: '#18181b' },
  error: { 50: '#fdf2f1', 100: '#fbe2df', 200: '#f3c3bd', 500: '#d8847b', 600: '#c44a4a', 700: '#9d433b' },
  warning: { 50: '#fbf6ef', 100: '#f4e9d9', 200: '#e7d2b4', 500: '#c09664', 600: '#a17a4b', 700: '#7b5d39' },
  success: { 50: '#f1f8f2', 100: '#dcefe0', 200: '#b8dcc0', 500: '#6cb17b', 600: '#4f8d5d', 700: '#3e704a' },
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif',
  radius: { sm: '6px', md: '8px', lg: '10px', xl: '12px' },
  shadow: { xs: '0 1px 2px rgb(10 13 18 / 0.05)', md: '0 4px 6px -1px rgb(10 13 18 / 0.1)', lg: '0 12px 16px -4px rgb(10 13 18 / 0.08)', xl: '0 20px 24px -4px rgb(10 13 18 / 0.08)' },
  extra: {
    'p-surface0': '#18181b',
    'p-surface1': '#1f1f22',
    'p-surface2': '#27272a',
    'p-border': '#27272a',
    'p-border-accent': '#303036',
    'p-foreground': '#fafafa',
    'p-muted': '#a1a1aa',
    'p-accent': '#e4e4e7',
    'p-success': '#6cb17b',
    'p-danger': '#d8847b',
    'p-warning': '#c09664',
  },
}

const ramp = (name) => Object.entries(app[name]).map(([step, value]) => `  --app-${name}-${step}: ${value};`).join('\n')

// ── 2. The engine contract ──────────────────────────────────────────────
const css = `/* GENERATED — do not edit by hand. Regenerate with: node tokens.mjs (this directory). */

:root {
  color-scheme: light;

${['gray', 'brand', 'error', 'warning', 'success'].map(ramp).join('\n')}
  --app-white: ${app.white};
${Object.entries(app.extra).map(([k, v]) => `  --app-${k}: ${v};`).join('\n')}

  --font-geist-sans: ${app.font};
  --font-geist-mono: ui-monospace, "SFMono-Regular", Menlo, monospace;
  --radius: ${app.radius.lg};
  --radius-sm: ${app.radius.sm};
  --radius-md: ${app.radius.md};
  --radius-lg: ${app.radius.lg};
  --radius-xl: ${app.radius.xl};
  --background: var(--app-white);
  --foreground: var(--app-gray-900);
  --card: var(--app-white);
  --card-foreground: var(--app-gray-900);
  --popover: var(--app-white);
  --popover-foreground: var(--app-gray-900);
  --primary: var(--app-brand-600);
  --primary-foreground: var(--app-white);
  --primary-hover: var(--app-brand-700);
  --accent-indigo: var(--app-brand-600);
  --accent-indigo-foreground: var(--app-white);
  --secondary: var(--app-gray-50);
  --secondary-foreground: var(--app-gray-900);
  --muted: var(--app-gray-50);
  --muted-foreground: var(--app-gray-600);
  --accent: var(--app-gray-50);
  --accent-foreground: var(--app-gray-900);
  --destructive: var(--app-error-600);
  --border: var(--app-gray-200);
  --input: var(--app-gray-300);
  --ring: var(--app-brand-500);
  --bg-disabled: var(--app-gray-100);
  --text-disabled: var(--app-gray-500);
  --border-disabled: var(--app-gray-300);
  --sidebar: var(--app-brand-900);
  --sidebar-foreground: var(--app-white);
  --sidebar-border: var(--app-brand-700);
  --chart-blue: var(--app-brand-600);
  --status-error-bg: var(--app-error-50);
  --status-error-text: var(--app-error-700);
  --status-error-border: var(--app-error-200);
  --status-error-icon: var(--app-error-500);
  --status-success-bg: var(--app-success-50);
  --status-success-text: var(--app-success-700);
  --status-success-border: var(--app-success-200);
  --status-success-icon: var(--app-success-500);
  --status-warning-bg: var(--app-warning-50);
  --status-warning-text: var(--app-warning-700);
  --status-warning-border: var(--app-warning-200);
  --status-warning-icon: var(--app-warning-500);
  --status-info-bg: var(--app-brand-50);
  --status-info-text: var(--app-brand-700);
  --status-info-border: var(--app-brand-200);
  --status-info-icon: var(--app-brand-500);
  --status-neutral-bg: var(--app-gray-50);
  --status-neutral-text: var(--app-gray-700);
  --status-neutral-border: var(--app-gray-200);
  --status-neutral-icon: var(--app-gray-500);
  --status-pink-bg: var(--app-brand-50);
  --status-pink-text: var(--app-brand-700);
  --status-pink-border: var(--app-brand-200);
  --status-pink-icon: var(--app-brand-500);
  --brand-lime: var(--app-brand-500);
  --brand-violet: var(--app-brand-600);
  --font-size-overline: 0.6875rem;
  --font-size-overline--line-height: 1rem;
  --z-index-base: 0;
  --z-index-sticky: 10;
  --z-index-dropdown: 20;
  --z-index-overlay: 30;
  --z-index-modal: 40;
  --z-index-popover: 45;
  --z-index-toast: 50;
  --z-index-tooltip: 60;
  --z-index-top: 100;
  --shadow-xs: ${app.shadow.xs};
  --shadow-sm: ${app.shadow.xs};
  --shadow-md: ${app.shadow.md};
  --shadow-lg: ${app.shadow.lg};
  --shadow-xl: ${app.shadow.xl};
  --shadow-2xl: ${app.shadow.xl};
  --shadow-focus: 0 0 0 2px var(--app-white), 0 0 0 4px var(--app-brand-500);
}

/* Add a .dark block only if the app has a dark theme; otherwise the toolbar toggle is a no-op. */
`

const unfilled = JSON.stringify(app).includes('"TODO"')
if (unfilled) {
  console.error('tokens.mjs still has placeholder values; fill them from the app\'s design tokens.')
  process.exitCode = 2
} else {
  fs.writeFileSync(path.join(here, 'tokens.css'), css)
  console.log('wrote tokens.css')
}
