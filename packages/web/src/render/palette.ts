/**
 * The palette. Flat, high-contrast, no images, no gradients that need decoding —
 * spec §2.3. Every colour the game draws is named here so the whole look can be
 * changed in one place, and so `src/ui/styles.css` can mirror it exactly.
 *
 * The colour language is one rule: **anything that can hurt you is warm** (boss
 * crimson, boss shots amber, telegraphs amber/red), **anything that is yours is cool**
 * (player mint, your shots cyan). Minions are violet because they are neither: they
 * hurt you but you can kill them.
 */
export const PALETTE = {
  void: '#07080c',
  floor: '#0d1017',
  grid: '#161b27',
  gridStrong: '#1e2534',
  border: '#2b3448',

  player: '#4de2b0',
  playerDim: '#1d6b57',
  playerShot: '#7ce7ff',

  boss: '#ff4d6d',
  bossDim: '#7a2439',
  bossShot: '#ffa040',

  minion: '#c084fc',

  telegraphCharge: '#ff4d6d',
  telegraphSlam: '#ffd166',

  spark: '#ffffff',
  text: '#e8ecf5',
  textDim: '#7d8799',
} as const;

/** `#rrggbb` + alpha -> `rgba(...)`. Cheap enough to call per draw call. */
export function alpha(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const clamped = a < 0 ? 0 : a > 1 ? 1 : a;
  return `rgba(${r}, ${g}, ${b}, ${clamped})`;
}
