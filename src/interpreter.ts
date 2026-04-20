import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Chess, SQUARES, type Move, type Square } from "chess.js";
import { parseDocument, preprocessSource, tokenizeGameBody, type BodyToken } from "./parser.ts";
import { findPackageRoot, resolveLibraryBoard } from "./lib-path.ts";
import { squareToIndex } from "./square.ts";
import { readLineSyncFromStdin } from "./stdin.ts";

export type RunOptions = {
  /** Absolute path to the entry .board file (for includes and cwd). */
  sourcePath?: string;
  /** Suppress say, fen, trace, pgn, sayreg (not return / match sum). */
  quiet?: boolean;
  /** Start each game with trace on (fen mode) before any directive runs. */
  traceDefault?: boolean;
  /** Parse and validate includes/libraries only; do not run chess. */
  dryRun?: boolean;
  /** Print JSON AST of top-level document and exit (after dry-run if both set). */
  printAst?: boolean;
};

type TraceMode = "fen" | "san";

type Ctx = {
  chess: Chess;
  cells: Int32Array;
  fenSeen: boolean;
  trace: boolean;
  traceMode: TraceMode;
  baseDir: string;
  includeChain: Set<string>;
  quiet: boolean;
  packageRoot: string;
  registers: Map<string, number>;
};

type GameRunResult = { returned: boolean; value: number };

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function log(ctx: Ctx, ...args: unknown[]): void {
  if (!ctx.quiet) console.log(...args);
}

function applyMoveMemory(cells: Int32Array, m: Move): void {
  const fromI = squareToIndex(m.from);
  const toI = squareToIndex(m.to);
  if (m.isCapture()) {
    if (m.isEnPassant()) {
      const capSq = `${m.to[0]}${m.from[1]}`;
      const capI = squareToIndex(capSq);
      cells[toI] += cells[fromI] + cells[capI] + 1;
      cells[capI] = 0;
    } else {
      const vCap = cells[toI];
      const vFrom = cells[fromI];
      cells[toI] = vFrom + vCap + 1;
    }
  } else {
    cells[toI] += 1;
  }
  if (m.isKingsideCastle() || m.isQueensideCastle()) {
    const rank = m.color === "w" ? "1" : "8";
    const rookTo = m.isKingsideCastle() ? `f${rank}` : `d${rank}`;
    cells[squareToIndex(rookTo)] += 1;
  }
}

function parseMoveArg(raw: string): { uci: { from: string; to: string; promotion?: string } } | { san: string } {
  const t = raw.trim();
  const uci = /^([a-h])([1-8])([a-h])([1-8])([qrbn])?$/i.exec(t);
  if (uci) {
    return {
      uci: {
        from: `${uci[1].toLowerCase()}${uci[2]}`,
        to: `${uci[3].toLowerCase()}${uci[4]}`,
        promotion: uci[5] ? uci[5].toLowerCase() : undefined,
      },
    };
  }
  let san = t;
  while (san.endsWith("+") || san.endsWith("#")) san = san.slice(0, -1);
  return { san };
}

function doChessMove(chess: Chess, raw: string): Move {
  const p = parseMoveArg(raw);
  if ("uci" in p) {
    return chess.move({
      from: p.uci.from as Square,
      to: p.uci.to as Square,
      promotion: p.uci.promotion as "q" | "r" | "b" | "n" | undefined,
    });
  }
  return chess.move(p.san);
}

function materialDiff(chess: Chess): number {
  let w = 0;
  let b = 0;
  for (const sq of SQUARES) {
    const piece = chess.get(sq);
    if (!piece) continue;
    const v = PIECE_VALUE[piece.type] ?? 0;
    if (piece.color === "w") w += v;
    else b += v;
  }
  return w - b;
}

function outcomeValue(chess: Chess): number {
  if (!chess.isGameOver()) {
    throw new Error("return outcome: game not finished (no mate / draw / stalemate yet)");
  }
  if (chess.isCheckmate()) {
    return chess.turn() === "w" ? -1 : 1;
  }
  return 0;
}

function assertIncludeSnippetOnly(source: string): void {
  const t = preprocessSource(source).trim();
  if (!t) return;
  const head5 = t.slice(0, 5).toLowerCase();
  if (head5.startsWith("game") || head5.startsWith("match")) {
    throw new Error(
      "Included file must be plain movetext (no top-level game { } or match { }); use snippets only.",
    );
  }
}

function parseIncludePath(text: string): string {
  const m = /^include\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/i.exec(text.trim());
  if (!m) throw new Error(`Bad include directive: ${text}`);
  const p = m[1] ?? m[2] ?? m[3] ?? "";
  if (!p) throw new Error("include path is empty");
  return p;
}

function parseLibraryName(text: string): string {
  const m = /^library\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/i.exec(text.trim());
  if (!m) throw new Error(`Bad library directive: ${text}`);
  const p = m[1] ?? m[2] ?? m[3] ?? "";
  if (!p) throw new Error("library name is empty");
  return p.replace(/[/\\]/g, "");
}

function regName(s: string): string {
  const m = /^[a-zA-Z_][a-zA-Z0-9_]*$/.exec(s);
  if (!m) throw new Error(`Bad register name: ${s}`);
  return s;
}

function handleDirective(
  text: string,
  ctx: Ctx,
): { kind: "ok" } | { kind: "return"; value: number } | { kind: "include"; absPath: string } {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  if (!cmd) return { kind: "ok" };

  if (cmd === "say" && parts[1]) {
    log(ctx, ctx.cells[squareToIndex(parts[1])]);
    return { kind: "ok" };
  }

  if (cmd === "fen") {
    log(ctx, ctx.chess.fen());
    return { kind: "ok" };
  }

  if (cmd === "pgn") {
    log(ctx, ctx.chess.pgn());
    return { kind: "ok" };
  }

  if (cmd === "trace") {
    const sub = parts[1]?.toLowerCase();
    if (!sub || sub === "on") {
      ctx.trace = true;
      ctx.traceMode = "fen";
      return { kind: "ok" };
    }
    if (sub === "off") {
      ctx.trace = false;
      return { kind: "ok" };
    }
    if (sub === "fen") {
      ctx.trace = true;
      ctx.traceMode = "fen";
      return { kind: "ok" };
    }
    if (sub === "san") {
      ctx.trace = true;
      ctx.traceMode = "san";
      return { kind: "ok" };
    }
    throw new Error(`trace: expected on | off | fen | san, got ${text}`);
  }

  if (cmd === "return") {
    const what = parts[1]?.toLowerCase();
    if (what === "outcome") {
      return { kind: "return", value: outcomeValue(ctx.chess) };
    }
    if (what === "material") {
      return { kind: "return", value: materialDiff(ctx.chess) };
    }
    if ((what === "cell" || what === "memory") && parts[2]) {
      return { kind: "return", value: ctx.cells[squareToIndex(parts[2])] };
    }
    if (what === "reg" && parts[2]) {
      const name = regName(parts[2]);
      return { kind: "return", value: ctx.registers.get(name) ?? 0 };
    }
    throw new Error(`return: expected outcome | material | cell <sq> | reg <name>, got ${text}`);
  }

  if (cmd === "assert") {
    const sub = parts[1]?.toLowerCase();
    if (!sub) throw new Error("assert: need check | notcheck | gameover | side …");
    if (sub === "check") {
      if (!ctx.chess.inCheck()) throw new Error("assert check failed");
    } else if (sub === "notcheck") {
      if (ctx.chess.inCheck()) throw new Error("assert notcheck failed");
    } else if (sub === "gameover") {
      if (!ctx.chess.isGameOver()) throw new Error("assert gameover failed");
    } else if (sub === "side") {
      const want = parts[2]?.toLowerCase();
      if (!want) throw new Error("assert side requires white|black");
      const t = ctx.chess.turn();
      if ((want === "white" || want === "w") && t !== "w") throw new Error("assert side white failed");
      if ((want === "black" || want === "b") && t !== "b") throw new Error("assert side black failed");
      if (want !== "white" && want !== "w" && want !== "black" && want !== "b") {
        throw new Error(`assert side: expected white|black, got ${parts[2]}`);
      }
    } else {
      throw new Error(`assert: unknown variant ${text}`);
    }
    return { kind: "ok" };
  }

  if (cmd === "set" && parts[1] && parts[2] !== undefined) {
    const sq = parts[1].toLowerCase();
    squareToIndex(sq);
    const n = Number(parts[2]);
    if (!Number.isFinite(n)) throw new Error(`set: bad number ${parts[2]}`);
    ctx.cells[squareToIndex(sq)] = n;
    return { kind: "ok" };
  }

  if (cmd === "read" && parts[1]) {
    const sq = parts[1].toLowerCase();
    squareToIndex(sq);
    const line = readLineSyncFromStdin();
    const n = parseInt(line, 10);
    if (!Number.isFinite(n)) throw new Error(`read: expected integer line, got ${JSON.stringify(line)}`);
    ctx.cells[squareToIndex(sq)] = n;
    return { kind: "ok" };
  }

  if (cmd === "let" && parts[1] && parts[2] !== undefined) {
    const name = regName(parts[1]);
    const n = Number(parts[2]);
    if (!Number.isFinite(n)) throw new Error(`let: bad number ${parts[2]}`);
    ctx.registers.set(name, n);
    return { kind: "ok" };
  }

  if (cmd === "inc" && parts[1]) {
    const name = regName(parts[1]);
    ctx.registers.set(name, (ctx.registers.get(name) ?? 0) + 1);
    return { kind: "ok" };
  }

  if (cmd === "dec" && parts[1]) {
    const name = regName(parts[1]);
    ctx.registers.set(name, (ctx.registers.get(name) ?? 0) - 1);
    return { kind: "ok" };
  }

  if (cmd === "add" && parts[1] && parts[2] !== undefined) {
    const name = regName(parts[1]);
    const n = Number(parts[2]);
    if (!Number.isFinite(n)) throw new Error(`add: bad number ${parts[2]}`);
    ctx.registers.set(name, (ctx.registers.get(name) ?? 0) + n);
    return { kind: "ok" };
  }

  if (cmd === "sayreg" && parts[1]) {
    const name = regName(parts[1]);
    log(ctx, ctx.registers.get(name) ?? 0);
    return { kind: "ok" };
  }

  if (cmd === "include") {
    const rawPath = parseIncludePath(text);
    const abs = resolve(ctx.baseDir, rawPath);
    return { kind: "include", absPath: abs };
  }

  if (cmd === "library") {
    const name = parseLibraryName(text);
    const abs = resolveLibraryBoard(ctx.packageRoot, name);
    return { kind: "include", absPath: abs };
  }

  throw new Error(`Unknown directive: ${text}`);
}

function maybeTrace(ctx: Ctx, m: Move): void {
  if (!ctx.trace) return;
  if (ctx.traceMode === "fen") log(ctx, `[trace] ${ctx.chess.fen()}`);
  else log(ctx, `[trace] ${m.san}`);
}

function collectBodiesFromDocument(source: string): string[] {
  const items = parseDocument(source);
  const bodies: string[] = [];
  for (const item of items) {
    if (item.kind === "implicit") bodies.push(item.body);
    else if (item.kind === "game") bodies.push(item.body);
    else for (const g of item.games) bodies.push(g.body);
  }
  return bodies;
}

function collectIncludePathsFromTokens(tokens: BodyToken[], baseDir: string, packageRoot: string): string[] {
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok.kind !== "directive") continue;
    const t = tok.text.trim();
    const low = t.toLowerCase();
    if (low.startsWith("include ")) {
      out.push(resolve(baseDir, parseIncludePath(t)));
    } else if (low.startsWith("library ")) {
      out.push(resolveLibraryBoard(packageRoot, parseLibraryName(t)));
    }
  }
  return out;
}

function dryValidate(source: string, options: RunOptions): void {
  const baseDir = options.sourcePath ? dirname(options.sourcePath) : process.cwd();
  const packageRoot = findPackageRoot(options.sourcePath ? dirname(options.sourcePath) : process.cwd());
  const bodies = collectBodiesFromDocument(source);
  const seen = new Set<string>();
  function walkBody(body: string, bd: string): void {
    const inner = tokenizeGameBody(body);
    const paths = collectIncludePathsFromTokens(inner, bd, packageRoot);
    for (const abs of paths) {
      if (!existsSync(abs)) throw new Error(`dry-run: missing file ${abs}`);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const sub = readFileSync(abs, "utf8");
      const subNorm = preprocessSource(sub);
      assertIncludeSnippetOnly(subNorm);
      walkBody(subNorm, dirname(abs));
    }
  }
  for (const b of bodies) walkBody(b, baseDir);
}

function runTokenList(tokens: BodyToken[], ctx: Ctx): GameRunResult {
  for (const tok of tokens) {
    if (tok.kind === "fen") {
      if (ctx.fenSeen) throw new Error("Only one FEN line allowed per game (use a new game block).");
      ctx.fenSeen = true;
      ctx.chess.load(tok.fen);
      continue;
    }
    if (tok.kind === "pgnHeader") {
      ctx.chess.setHeader(tok.key, tok.value);
      continue;
    }
    if (tok.kind === "directive") {
      const d = handleDirective(tok.text, ctx);
      if (d.kind === "return") {
        return { returned: true, value: d.value };
      }
      if (d.kind === "include") {
        if (ctx.includeChain.has(d.absPath)) {
          throw new Error(`Circular include: ${d.absPath}`);
        }
        const innerSource = readFileSync(d.absPath, "utf8");
        const innerNorm = preprocessSource(innerSource);
        assertIncludeSnippetOnly(innerNorm);
        const innerTokens = tokenizeGameBody(innerNorm);
        ctx.includeChain.add(d.absPath);
        const prevBase = ctx.baseDir;
        ctx.baseDir = dirname(d.absPath);
        try {
          const innerRes = runTokenList(innerTokens, ctx);
          if (innerRes.returned) return innerRes;
        } finally {
          ctx.baseDir = prevBase;
          ctx.includeChain.delete(d.absPath);
        }
      }
      continue;
    }
    const m = doChessMove(ctx.chess, tok.raw);
    applyMoveMemory(ctx.cells, m);
    maybeTrace(ctx, m);
  }
  return { returned: false, value: 0 };
}

function createCtx(
  baseDir: string,
  chain: Set<string>,
  packageRoot: string,
  quiet: boolean,
  traceDefault: boolean,
): Ctx {
  return {
    chess: new Chess(),
    cells: new Int32Array(64),
    fenSeen: false,
    trace: traceDefault,
    traceMode: "fen",
    baseDir,
    includeChain: chain,
    quiet,
    packageRoot,
    registers: new Map<string, number>(),
  };
}

function runGameBody(
  body: string,
  baseDir: string,
  chain: Set<string>,
  packageRoot: string,
  quiet: boolean,
  traceDefault: boolean,
): GameRunResult {
  const ctx = createCtx(baseDir, chain, packageRoot, quiet, traceDefault);
  const tokens = tokenizeGameBody(body);
  return runTokenList(tokens, ctx);
}

function emitGameResult(r: GameRunResult): void {
  if (r.returned) console.log(r.value);
}

export function runProgram(source: string, options?: RunOptions): void {
  if (options?.printAst) {
    console.log(JSON.stringify(parseDocument(source), null, 2));
  }
  if (options?.dryRun) {
    dryValidate(source, options ?? {});
    console.log("dry-run ok");
    return;
  }
  if (options?.printAst) {
    return;
  }

  const baseDir = options?.sourcePath ? dirname(options.sourcePath) : process.cwd();
  const packageRoot = findPackageRoot(options?.sourcePath ? dirname(options.sourcePath) : process.cwd());
  const rootChain = new Set<string>();
  const quiet = options?.quiet ?? false;
  const traceDefault = options?.traceDefault ?? false;

  const items = parseDocument(source);
  if (items.length === 0) return;

  for (const item of items) {
    if (item.kind === "implicit") {
      const r = runGameBody(item.body, baseDir, rootChain, packageRoot, quiet, traceDefault);
      emitGameResult(r);
    } else if (item.kind === "game") {
      const r = runGameBody(item.body, baseDir, rootChain, packageRoot, quiet, traceDefault);
      emitGameResult(r);
    } else if (item.kind === "match") {
      let sum = 0;
      let anyReturn = false;
      for (const g of item.games) {
        const r = runGameBody(g.body, baseDir, rootChain, packageRoot, quiet, traceDefault);
        if (r.returned) {
          anyReturn = true;
          sum += r.value;
        }
      }
      if (anyReturn) console.log(sum);
    }
  }
}
