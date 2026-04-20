/** Algebraic square ↔ linear index (a1 = 0 … h8 = 63, rank in file-major row order). */
const FILE_A = "a".charCodeAt(0);

export function squareToIndex(sq: string): number {
  const s = sq.trim().toLowerCase();
  const m = /^([a-h])([1-8])$/.exec(s);
  if (!m) throw new Error(`Bad square: ${sq}`);
  const file = m[1].charCodeAt(0) - FILE_A;
  const rank = Number(m[2]) - 1;
  return rank * 8 + file;
}

export function indexToSquare(i: number): string {
  if (i < 0 || i > 63) throw new Error(`Bad square index: ${i}`);
  const file = String.fromCharCode(FILE_A + (i % 8));
  const rank = Math.floor(i / 8) + 1;
  return `${file}${rank}`;
}
