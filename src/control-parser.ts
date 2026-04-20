/**
 * Game body: statements including if / while / for / break / continue,
 * plus legacy movetext lines, FEN, PGN tags, and directives.
 */

import { readBalancedBlock, skipWsAndComments, parseGameSequenceInner, type GameAst } from "./parser.ts";
import { parseMoveToken } from "./move-decor.ts";
import { parseExpr, type ExprAst } from "./expr.ts";

export type Stmt =
  | { kind: "fen"; fen: string }
  | { kind: "pgnHeader"; key: string; value: string }
  | { kind: "directive"; text: string }
  | { kind: "move"; core: string; nag?: number; glyphs?: string }
  | { kind: "if"; cond: ExprAst; then: Stmt[]; elseSt?: Stmt[] }
  | { kind: "while"; cond: ExprAst; body: Stmt[] }
  | { kind: "for"; varName: string; from: number; to: number; body: Stmt[] }
  | { kind: "break" }
  | { kind: "continue" }
  | { kind: "nestedGame"; name?: string; body: string }
  | { kind: "nestedTournament"; mode: "all" | "race"; games: GameAst[] };

const FEN_LINE = /^FEN\s+("([^"]*)"|'([^']*)')\s*$/i;
const PGN_TAG_LINE = /^\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"])*)"\]\s*$/;
const INCLUDE_LINE = /^include\s+("([^"]*)"|'([^']*)')\s*$/i;
const LIBRARY_LINE = /^library\s+("([^"]*)"|'([^']*)'|(\w+))\s*$/i;

function startsWithKw(s: string, i: number, kw: string): boolean {
  if (i + kw.length > s.length) return false;
  if (s.slice(i, i + kw.length).toLowerCase() !== kw) return false;
  const j = i + kw.length;
  if (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) return false;
  return true;
}

function readLogicalLine(s: string, i: number, end: number): { line: string; next: number } {
  const start = i;
  while (i < end && s[i] !== "\n" && s[i] !== "\r") i++;
  const line = s.slice(start, i).trim();
  if (i < end && s[i] === "\r") i++;
  if (i < end && s[i] === "\n") i++;
  return { line, next: i };
}

function readIdentifier(s: string, i: number, end: number): { id: string; next: number } | null {
  i = skipWsAndComments(s, i);
  if (i >= end) return null;
  const c = s[i];
  if (!/[a-zA-Z_]/.test(c)) return null;
  const st = i;
  i++;
  while (i < end && /[a-zA-Z0-9_]/.test(s[i])) i++;
  return { id: s.slice(st, i), next: i };
}

function readInteger(s: string, i: number, end: number): { n: number; next: number } | null {
  i = skipWsAndComments(s, i);
  if (i >= end) return null;
  let neg = false;
  if (s[i] === "-") {
    neg = true;
    i++;
  }
  if (i >= end || !/[0-9]/.test(s[i])) return null;
  const st = i;
  while (i < end && /[0-9]/.test(s[i])) i++;
  let n = Number(s.slice(st, i));
  if (neg) n = -n;
  return { n, next: i };
}

function tokenizeMovetextLine(line: string): Stmt[] {
  const out: Stmt[] = [];
  const re = /\{[^}]*\}|[^\s{}]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const tok = m[0];
    if (tok.startsWith("{")) {
      out.push({ kind: "directive", text: tok.slice(1, -1).trim() });
    } else {
      const p = parseMoveToken(tok);
      out.push({
        kind: "move",
        core: p.core,
        nag: p.nag,
        glyphs: p.glyphs,
      });
    }
  }
  return out;
}

function parseBlock(s: string, start: number, end: number): { stmts: Stmt[]; next: number } {
  let i = start;
  const stmts: Stmt[] = [];
  while (i < end) {
    i = skipWsAndComments(s, i);
    if (i < end && s[i] === "}") {
      return { stmts, next: i + 1 };
    }
    if (i >= end) break;
    const r = parseStatement(s, i, end);
    for (const st of r.stmts) stmts.push(st);
    i = r.next;
  }
  return { stmts, next: i };
}

function parseIf(s: string, i: number, end: number): { stmts: Stmt[]; next: number } {
  i += 2;
  i = skipWsAndComments(s, i);
  const exprStart = i;
  while (i < end && s[i] !== "{") {
    i++;
  }
  const exprStr = s.slice(exprStart, i).trim();
  if (!exprStr) throw new Error("if: missing condition");
  const cond = parseExpr(exprStr);
  if (s[i] !== "{") throw new Error("if: expected {");
  const { inner, closePos } = readBalancedBlock(s, i);
  const then = parseBlock(inner, 0, inner.length).stmts;
  let next = closePos;
  let elseSt: Stmt[] | undefined;
  next = skipWsAndComments(s, next);
  if (startsWithKw(s, next, "else")) {
    next += 4;
    next = skipWsAndComments(s, next);
    if (next >= end || s[next] !== "{") throw new Error("else: expected {");
    const e2 = readBalancedBlock(s, next);
    elseSt = parseBlock(e2.inner, 0, e2.inner.length).stmts;
    next = e2.closePos;
  }
  return { stmts: [{ kind: "if", cond, then, elseSt }], next };
}

function parseWhile(s: string, i: number, end: number): { stmts: Stmt[]; next: number } {
  i += 5;
  i = skipWsAndComments(s, i);
  const exprStart = i;
  while (i < end && s[i] !== "{") {
    i++;
  }
  const exprStr = s.slice(exprStart, i).trim();
  const cond = parseExpr(exprStr);
  if (s[i] !== "{") throw new Error("while: expected {");
  const { inner, closePos } = readBalancedBlock(s, i);
  const body = parseBlock(inner, 0, inner.length).stmts;
  return { stmts: [{ kind: "while", cond, body }], next: closePos };
}

function parseNestedGameStmt(s: string, i: number, end: number): { stmts: Stmt[]; next: number } {
  let j = i;
  if (!startsWithKw(s, j, "game")) throw new Error("nested game: expected game");
  j += 4;
  j = skipWsAndComments(s, j);
  let name: string | undefined;
  const id = readIdentifier(s, j, end);
  if (id) {
    name = id.id;
    j = id.next;
  }
  j = skipWsAndComments(s, j);
  if (j >= end || s[j] !== "{") throw new Error("nested game: expected {");
  const { inner, closePos } = readBalancedBlock(s, j);
  return { stmts: [{ kind: "nestedGame", name, body: inner }], next: closePos };
}

function parseNestedTournamentStmt(s: string, i: number, end: number): { stmts: Stmt[]; next: number } {
  let j = i;
  if (!startsWithKw(s, j, "tournament")) throw new Error("nested tournament: expected tournament");
  j += 10;
  j = skipWsAndComments(s, j);
  const id = readIdentifier(s, j, end);
  if (!id) throw new Error("nested tournament: expected all | race");
  const mode = id.id.toLowerCase();
  if (mode !== "all" && mode !== "race") {
    throw new Error(`nested tournament: mode must be all | race, got ${id.id}`);
  }
  j = skipWsAndComments(s, id.next);
  if (j >= end || s[j] !== "{") throw new Error("nested tournament: expected {");
  const { inner, closePos } = readBalancedBlock(s, j);
  const games = parseGameSequenceInner(inner);
  if (games.length < 1) throw new Error("nested tournament: need at least one game block");
  return {
    stmts: [{ kind: "nestedTournament", mode: mode as "all" | "race", games }],
    next: closePos,
  };
}

function parseFor(s: string, i: number, end: number): { stmts: Stmt[]; next: number } {
  i += 3;
  i = skipWsAndComments(s, i);
  const id = readIdentifier(s, i, end);
  if (!id) throw new Error("for: expected variable name");
  i = id.next;
  let j = skipWsAndComments(s, i);
  if (!startsWithKw(s, j, "from")) throw new Error("for: expected from");
  i = j + 4;
  const fromN = readInteger(s, i, end);
  if (!fromN) throw new Error("for: expected integer after from");
  i = fromN.next;
  j = skipWsAndComments(s, i);
  if (!startsWithKw(s, j, "to")) throw new Error("for: expected to");
  i = j + 2;
  const toN = readInteger(s, i, end);
  if (!toN) throw new Error("for: expected integer after to");
  i = toN.next;
  i = skipWsAndComments(s, i);
  if (i >= end || s[i] !== "{") throw new Error("for: expected {");
  const { inner, closePos } = readBalancedBlock(s, i);
  const body = parseBlock(inner, 0, inner.length).stmts;
  const v = id.id;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) throw new Error(`for: bad variable ${v}`);
  return { stmts: [{ kind: "for", varName: v, from: fromN.n, to: toN.n, body }], next: closePos };
}

function parseStatement(s: string, i: number, end: number): { stmts: Stmt[]; next: number } {
  i = skipWsAndComments(s, i);
  if (i >= end) return { stmts: [], next: i };
  if (s[i] === "}") return { stmts: [], next: i };

  if (startsWithKw(s, i, "if")) return parseIf(s, i, end);
  if (startsWithKw(s, i, "while")) return parseWhile(s, i, end);
  if (startsWithKw(s, i, "for")) return parseFor(s, i, end);
  if (startsWithKw(s, i, "break")) {
    const { next } = readLogicalLine(s, i, end);
    return { stmts: [{ kind: "break" }], next };
  }
  if (startsWithKw(s, i, "continue")) {
    const { next } = readLogicalLine(s, i, end);
    return { stmts: [{ kind: "continue" }], next };
  }
  if (startsWithKw(s, i, "else")) {
    throw new Error("else without matching if");
  }

  if (startsWithKw(s, i, "tournament")) {
    return parseNestedTournamentStmt(s, i, end);
  }
  if (startsWithKw(s, i, "game")) {
    return parseNestedGameStmt(s, i, end);
  }

  const { line, next } = readLogicalLine(s, i, end);
  if (!line) return { stmts: [], next };

  const fenM = FEN_LINE.exec(line);
  if (fenM) {
    return { stmts: [{ kind: "fen", fen: fenM[2] ?? fenM[3] ?? "" }], next };
  }
  const tagM = PGN_TAG_LINE.exec(line);
  if (tagM) {
    const rawVal = tagM[2] ?? "";
    const value = rawVal.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return { stmts: [{ kind: "pgnHeader", key: tagM[1], value }], next };
  }
  const sayM = /^say\s+([a-h][1-8])\s*$/i.exec(line);
  if (sayM) {
    return { stmts: [{ kind: "directive", text: `say ${sayM[1].toLowerCase()}` }], next };
  }
  const incM = INCLUDE_LINE.exec(line);
  if (incM) {
    return { stmts: [{ kind: "directive", text: `include ${incM[2] ?? incM[3] ?? ""}` }], next };
  }
  const libM = LIBRARY_LINE.exec(line);
  if (libM) {
    const name = libM[2] ?? libM[3] ?? libM[4] ?? "";
    return { stmts: [{ kind: "directive", text: `library ${name}` }], next };
  }

  return { stmts: tokenizeMovetextLine(line), next };
}

export function parseGameBody(body: string): Stmt[] {
  const s = body;
  const end = s.length;
  let i = 0;
  const out: Stmt[] = [];
  while (i < end) {
    i = skipWsAndComments(s, i);
    if (i >= end) break;
    const r = parseStatement(s, i, end);
    for (const st of r.stmts) out.push(st);
    i = r.next;
  }
  return out;
}
