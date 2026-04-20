/**
 * SAN/UCI tokens may end with PGN NAG `$n` and/or move-quality suffixes before check/mate markers.
 */

export type ParsedMoveToken = {
  /** SAN or UCI string passed to chess.js (check/mate markers stripped). */
  core: string;
  /** PGN numeric annotation glyph, if present. */
  nag?: number;
  /** Concatenated suffix glyphs in source order (e.g. "!?", "!!"). */
  glyphs?: string;
};

export const MOVE_GLYPH_PREFIXES = ["!!", "??", "!?", "?!", "!", "?"] as const;

export function forEachMoveGlyph(glyphs: string, fn: (g: (typeof MOVE_GLYPH_PREFIXES)[number]) => void): void {
  let rest = glyphs;
  while (rest.length > 0) {
    let hit: (typeof MOVE_GLYPH_PREFIXES)[number] | undefined;
    for (const g of MOVE_GLYPH_PREFIXES) {
      if (rest.startsWith(g)) {
        hit = g;
        break;
      }
    }
    if (!hit) throw new Error(`invalid move glyph sequence: ${glyphs}`);
    fn(hit);
    rest = rest.slice(hit.length);
  }
}

/** Strip `$n`, move-quality suffixes, then trailing `+` / `#` for the engine. */
export function parseMoveToken(raw: string): ParsedMoveToken {
  let t = raw.trim();
  let nag: number | undefined;
  const nagEnd = /\$(\d+)\s*$/.exec(t);
  if (nagEnd) {
    nag = Number(nagEnd[1]);
    t = t.slice(0, nagEnd.index).trimEnd();
  }
  const glyphBuf: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of MOVE_GLYPH_PREFIXES) {
      if (t.endsWith(g)) {
        glyphBuf.push(g);
        t = t.slice(0, -g.length).trimEnd();
        changed = true;
        break;
      }
    }
  }
  let core = t;
  while (core.endsWith("+") || core.endsWith("#")) {
    core = core.slice(0, -1);
  }
  return {
    core: core.trim(),
    nag,
    glyphs: glyphBuf.length ? glyphBuf.join("") : undefined,
  };
}
