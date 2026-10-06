import {create} from 'zustand';

export type Theme = 'dark' | 'light';
const KEY = 'eraseops.theme';
const META: Record<Theme, string> = {dark: '#0d0c0a', light: '#f3ecdd'};

const current = (): Theme => (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** Applies a theme to <html>; index.html runs the same logic before first paint. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[theme]);
  try { localStorage.setItem(KEY, theme); } catch { /* storage can be unavailable */ }
}

export const useTheme = create<{theme: Theme; setTheme: (theme: Theme) => void}>(set => ({
  theme: current(),
  setTheme: theme => { applyTheme(theme); set({theme}); },
}));

/** Reads a resolved theme token, for canvas and SVG code that cannot use var(). */
export function themeColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

/** "#d9b46a" -> [217, 180, 106] */
export function rgbOf(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map(char => char + char).join('') : value;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}
