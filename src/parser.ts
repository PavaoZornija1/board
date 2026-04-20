/**
 * Surface syntax: `game` / `match` / `tournament`, SAN movetext, `{directives}`, optional `FEN "..."`.
 */

import { parseMoveToken } from "./move-decor.ts";

export type GameAst = { kind: "game"; name?: string; body: string };

export type MatchAst = { kind: "match"; count: number; games: GameAst[] };

export type TournamentAst = { kind: "tournament"; mode: "all" | "race"; games: GameAst[] };

export type TopLevel = GameAst | MatchAst | TournamentAst | { kind: "implicit"; body: string };

export type BodyToken =
  | { kind: "fen"; fen: string }
  | { kind: "pgnHeader"; key: string; value: string }
  | { kind: "directive"; text: string }
  | { kind: "move"; raw: string };

const FEN_LINE = /^FEN\s+("([^"]*)"|'([^']*)')\s*$/i;

const INCLUDE_LINE = /^include\s+("([^"]*)"|'([^']*)')\s*$/i;

const PGN_TAG_LINE = /^\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"])*)"\]\s*$/;

const LIBRARY_LINE = /^library\s+("([^"]*)"|'([^']*)'|(\w+))\s*$/i;

function stripHashComment(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return "";
  const idx = line.search(/\s+#/);
  if (idx === -1) return line;
  return line.slice(0, idx).trimEnd();
}

/** Remove line comments; trim each line; preserve newlines for error positions. */
export function preprocessSource(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => stripHashComment(line).trimEnd())
    .join("\n");
}

export function skipWsAndComments(s: string, i: number): number {
  const len = s.length;
  while (i < len) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < len && s[i] !== "\n") i++;
      continue;
    }
    break;
  }
  return i;
}

/** Read `{` … `}` with nested `{` `}` balanced. `openPos` must point at `{`. */
export function readBalancedBlock(s: string, openPos: number): { inner: string; closePos: number } {
  if (s[openPos] !== "{") throw new Error(`Expected { at ${openPos}`);
  let depth = 0;
  for (let i = openPos; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return { inner: s.slice(openPos + 1, i), closePos: i + 1 };
    }
  }
  throw new Error("Unclosed {");
}

function readIdentifier(s: string, i: number): { id: string; next: number } | null {
  const len = s.length;
  if (i >= len) return null;
  const c = s[i];
  if (!/[a-zA-Z_]/.test(c)) return null;
  let j = i + 1;
  while (j < len && /[a-zA-Z0-9_]/.test(s[j])) j++;
  return { id: s.slice(i, j), next: j };
}

function readInteger(s: string, i: number): { n: number; next: number } | null {
  const len = s.length;
  let j = skipWsAndComments(s, i);
  if (j >= len || !/[0-9]/.test(s[j])) return null;
  const start = j;
  while (j < len && /[0-9]/.test(s[j])) j++;
  return { n: Number(s.slice(start, j)), next: j };
}

/** Parse a sequence of `game { … }` blocks (used by `match`, `tournament`, and nested tournament statements). */
export function parseGameSequenceInner(inner: string): GameAst[] {
  const games: GameAst[] = [];
  let k = 0;
  const innerLen = inner.length;
  while (k < innerLen) {
    k = skipWsAndComments(inner, k);
    if (k >= innerLen) break;
    const g = parseGameBlock(inner, k);
    games.push(g.game);
    k = skipWsAndComments(inner, g.next);
  }
  return games;
}

function parseGameBlock(s: string, i: number): { game: GameAst; next: number } {
  let j = skipWsAndComments(s, i);
  if (!s.slice(j, j + 4).toLowerCase().startsWith("game")) {
    throw new Error(`Expected game at ${j}`);
  }
  j += 4;
  j = skipWsAndComments(s, j);
  let name: string | undefined;
  const id = readIdentifier(s, j);
  if (id) {
    name = id.id;
    j = id.next;
  }
  j = skipWsAndComments(s, j);
  if (s[j] !== "{") throw new Error(`Expected { after game`);
  const { inner, closePos } = readBalancedBlock(s, j);
  return { game: { kind: "game", name, body: inner }, next: closePos };
}

function parseMatchBlock(s: string, i: number): { match: MatchAst; next: number } {
  let j = skipWsAndComments(s, i);
  if (!s.slice(j, j + 5).toLowerCase().startsWith("match")) {
    throw new Error(`Expected match at ${j}`);
  }
  j += 5;
  const num = readInteger(s, j);
  if (!num || num.n < 1) throw new Error("match requires a positive integer");
  j = skipWsAndComments(s, num.next);
  if (s[j] !== "{") throw new Error(`Expected { after match count`);
  const { inner, closePos } = readBalancedBlock(s, j);
  const games = parseGameSequenceInner(inner);
  if (games.length !== num.n) {
    throw new Error(`match ${num.n} requires exactly ${num.n} game blocks, got ${games.length}`);
  }
  return { match: { kind: "match", count: num.n, games }, next: closePos };
}

function parseTournamentBlock(s: string, i: number): { tournament: TournamentAst; next: number } {
  let j = skipWsAndComments(s, i);
  if (!s.slice(j, j + 10).toLowerCase().startsWith("tournament")) {
    throw new Error(`Expected tournament at ${j}`);
  }
  j += 10;
  j = skipWsAndComments(s, j);
  const id = readIdentifier(s, j);
  if (!id) throw new Error("tournament requires a mode: all | race");
  const mode = id.id.toLowerCase();
  if (mode !== "all" && mode !== "race") {
    throw new Error(`tournament mode must be all | race, got ${id.id}`);
  }
  j = skipWsAndComments(s, id.next);
  if (s[j] !== "{") throw new Error(`Expected { after tournament ${mode}`);
  const { inner, closePos } = readBalancedBlock(s, j);
  const games = parseGameSequenceInner(inner);
  if (games.length < 1) {
    throw new Error("tournament requires at least one game block");
  }
  return {
    tournament: { kind: "tournament", mode: mode as "all" | "race", games },
    next: closePos,
  };
}

export function parseDocument(source: string): TopLevel[] {
  const s = preprocessSource(source);
  const out: TopLevel[] = [];
  let i = skipWsAndComments(s, 0);
  if (i >= s.length) return out;

  const head = s.slice(i, i + 10).toLowerCase();
  if (!head.startsWith("match") && !head.startsWith("game") && !head.startsWith("tournament")) {
    out.push({ kind: "implicit", body: s.slice(i) });
    return out;
  }

  while (i < s.length) {
    i = skipWsAndComments(s, i);
    if (i >= s.length) break;
    if (s.slice(i, i + 10).toLowerCase().startsWith("tournament")) {
      const { tournament, next } = parseTournamentBlock(s, i);
      out.push(tournament);
      i = next;
      continue;
    }
    if (s.slice(i, i + 5).toLowerCase().startsWith("match")) {
      const { match, next } = parseMatchBlock(s, i);
      out.push(match);
      i = next;
      continue;
    }
    if (s.slice(i, i + 4).toLowerCase().startsWith("game")) {
      const { game, next } = parseGameBlock(s, i);
      out.push(game);
      i = next;
      continue;
    }
    throw new Error(`Unexpected token at ${i}: ${s.slice(i, i + 20)}`);
  }
  return out;
}

export function tokenizeGameBody(body: string): BodyToken[] {
  const tokens: BodyToken[] = [];
  const lines = body.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const fenM = FEN_LINE.exec(line);
    if (fenM) {
      tokens.push({ kind: "fen", fen: fenM[2] ?? fenM[3] ?? "" });
      continue;
    }
    const tagM = PGN_TAG_LINE.exec(line);
    if (tagM) {
      const rawVal = tagM[2] ?? "";
      const value = rawVal.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      tokens.push({ kind: "pgnHeader", key: tagM[1], value });
      continue;
    }
    const sayM = /^say\s+([a-h][1-8])\s*$/i.exec(line);
    if (sayM) {
      tokens.push({ kind: "directive", text: `say ${sayM[1].toLowerCase()}` });
      continue;
    }
    const incM = INCLUDE_LINE.exec(line);
    if (incM) {
      tokens.push({ kind: "directive", text: `include ${incM[2] ?? incM[3] ?? ""}` });
      continue;
    }
    const libM = LIBRARY_LINE.exec(line);
    if (libM) {
      const name = libM[2] ?? libM[3] ?? libM[4] ?? "";
      tokens.push({ kind: "directive", text: `library ${name}` });
      continue;
    }
    const re = /\{[^}]*\}|[^\s{}]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const tok = m[0];
      if (tok.startsWith("{")) {
        tokens.push({ kind: "directive", text: tok.slice(1, -1).trim() });
      } else {
        const p = parseMoveToken(tok);
        tokens.push({ kind: "move", raw: p.core });
      }
    }
  }
  return tokens;
}
