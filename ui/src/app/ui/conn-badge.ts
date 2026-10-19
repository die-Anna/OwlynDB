/** Schrift auf dem Kürzel einer Verbindung: dunkel auf hellen Farben (Gelb, Orange), sonst weiß */
export function badgeInk(color: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#1d1d1f' : '#fff';
}
