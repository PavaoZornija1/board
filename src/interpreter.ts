import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { Chess, SQUARES, type Move, type Square } from "chess.js";
import { forEachMoveGlyph } from "./move-decor.ts";
import { parseDocument, preprocessSource, type GameAst } from "./parser.ts";
import { parseGameBody, type Stmt } from "./control-parser.ts";
import { evalExpr, type EvalEnv } from "./expr.ts";
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

type VariantProfile = "standard" | "chess960";

type CtxSnapshot = {
  fen: string;
  cells: Int32Array;
  registers: Map<string, number>;
  fenSeen: boolean;
  trace: boolean;
  traceMode: TraceMode;
  headers: Record<string, string>;
  resignLoser?: "w" | "b";
  variantProfile: VariantProfile;
};

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
  /** When set, `log` appends here instead of printing (tournament workers). */
  lineCapture?: string[];
  /** Tournament branches disallow `{read}` (stdin is undefined per worker). */
  forbidStdin: boolean;
  /** Side that resigned; terminal for `gameover` / `return outcome`. */
  resignLoser?: "w" | "b";
  variantProfile: VariantProfile;
};

type GameRunResult = { returned: boolean; value: number };

type PhaseRet =
  | { kind: "ok" }
  | { kind: "return"; value: number }
  | { kind: "break" }
  | { kind: "continue" };

const MAX_LOOP = 100_000;

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function log(ctx: Ctx, ...args: unknown[]): void {
  if (ctx.lineCapture) {
    ctx.lineCapture.push(args.map((x) => String(x)).join(" "));
    return;
  }
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

function outcomeValue(ctx: Ctx): number {
  if (ctx.resignLoser === "w") return -1;
  if (ctx.resignLoser === "b") return 1;
  const chess = ctx.chess;
  if (!chess.isGameOver()) {
    throw new Error("return outcome: game not finished (no mate / draw / stalemate / resign yet)");
  }
  if (chess.isCheckmate()) {
    return chess.turn() === "w" ? -1 : 1;
  }
  return 0;
}

function takeSnapshot(ctx: Ctx): CtxSnapshot {
  return {
    fen: ctx.chess.fen(),
    cells: Int32Array.from(ctx.cells),
    registers: new Map(ctx.registers),
    fenSeen: ctx.fenSeen,
    trace: ctx.trace,
    traceMode: ctx.traceMode,
    headers: { ...ctx.chess.getHeaders() },
    resignLoser: ctx.resignLoser,
    variantProfile: ctx.variantProfile,
  };
}

function restoreSnapshot(ctx: Ctx, s: CtxSnapshot): void {
  ctx.chess.load(s.fen, { preserveHeaders: false });
  for (const [k, v] of Object.entries(s.headers)) {
    ctx.chess.setHeader(k, v);
  }
  ctx.cells.set(s.cells);
  ctx.registers = new Map(s.registers);
  ctx.fenSeen = s.fenSeen;
  ctx.trace = s.trace;
  ctx.traceMode = s.traceMode;
  ctx.resignLoser = s.resignLoser;
  ctx.variantProfile = s.variantProfile;
}

function applyMoveAnnotations(ctx: Ctx, glyphs?: string, nag?: number): void {
  if (glyphs) {
    forEachMoveGlyph(glyphs, (g) => {
      switch (g) {
        case "!!":
          if (!ctx.chess.inCheck()) throw new Error("move annotation !!: expected opponent in check");
          break;
        case "??":
          log(ctx, "[annotation] ??");
          break;
        case "!":
          log(ctx, "[annotation] !");
          break;
        case "?":
          log(ctx, "[annotation] ?");
          break;
        case "!?":
          log(ctx, "[annotation] !?");
          break;
        case "?!":
          log(ctx, "[annotation] ?!");
          break;
        default:
          break;
      }
    });
  }
  if (nag === undefined) return;
  const brilliant = new Set([3, 103, 187]);
  const mistake = new Set([4, 104, 185]);
  const dubious = new Set([2, 6, 44, 132]);
  if (brilliant.has(nag)) {
    if (!ctx.chess.inCheck()) throw new Error(`NAG $${nag}: expected opponent in check`);
  } else if (mistake.has(nag)) {
    log(ctx, `[annotation] $${nag} (mistake)`);
  } else if (dubious.has(nag)) {
    log(ctx, `[annotation] $${nag}`);
  }
}

function assertIncludeSnippetOnly(source: string): void {
  const t = preprocessSource(source).trim();
  if (!t) return;
  const head10 = t.slice(0, 10).toLowerCase();
  const head5 = t.slice(0, 5).toLowerCase();
  if (head10.startsWith("tournament") || head5.startsWith("game") || head5.startsWith("match")) {
    throw new Error(
      "Included file must be plain movetext (no top-level game { }, match { }, or tournament { }); use snippets only.",
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
      return { kind: "return", value: outcomeValue(ctx) };
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
      if (!ctx.chess.isGameOver() && ctx.resignLoser === undefined) {
        throw new Error("assert gameover failed");
      }
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
    if (ctx.forbidStdin) {
      throw new Error(
        "{read} is not allowed inside a tournament game (each branch runs in its own worker; stdin is undefined).",
      );
    }
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

  if (cmd === "resign") {
    if (ctx.resignLoser !== undefined) throw new Error("resign: position is already finished");
    if (ctx.chess.isGameOver()) throw new Error("resign: game is already over on the board");
    ctx.resignLoser = ctx.chess.turn();
    return { kind: "ok" };
  }

  if (cmd === "variant") {
    const sub = parts[1]?.toLowerCase();
    if (!sub) throw new Error("variant: expected standard | chess960");
    if (sub === "standard") {
      ctx.variantProfile = "standard";
      ctx.chess.removeHeader("Variant");
      return { kind: "ok" };
    }
    if (sub === "chess960" || sub === "fischer960") {
      ctx.variantProfile = "chess960";
      ctx.chess.setHeader("Variant", "Chess960");
      return { kind: "ok" };
    }
    throw new Error(`variant: unknown ${parts[1]}`);
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
    else if (item.kind === "tournament") {
      for (const g of item.games) bodies.push(g.body);
    } else for (const g of item.games) bodies.push(g.body);
  }
  return bodies;
}

function collectIncludePathsFromStmts(stmts: Stmt[], baseDir: string, packageRoot: string): string[] {
  const out: string[] = [];
  function walk(st: Stmt[]): void {
    for (const s of st) {
      if (s.kind === "directive") {
        const t = s.text.trim();
        const low = t.toLowerCase();
        if (low.startsWith("include ")) {
          out.push(resolve(baseDir, parseIncludePath(t)));
        } else if (low.startsWith("library ")) {
          out.push(resolveLibraryBoard(packageRoot, parseLibraryName(t)));
        }
      } else if (s.kind === "if") {
        walk(s.then);
        if (s.elseSt) walk(s.elseSt);
      } else if (s.kind === "while") {
        walk(s.body);
      } else if (s.kind === "for") {
        walk(s.body);
      } else if (s.kind === "nestedGame") {
        walk(parseGameBody(s.body));
      } else if (s.kind === "nestedTournament") {
        for (const g of s.games) walk(parseGameBody(g.body));
      }
    }
  }
  walk(stmts);
  return out;
}

function dryValidate(source: string, options: RunOptions): void {
  const baseDir = options.sourcePath ? dirname(options.sourcePath) : process.cwd();
  const packageRoot = findPackageRoot(options.sourcePath ? dirname(options.sourcePath) : process.cwd());
  const bodies = collectBodiesFromDocument(source);
  const seen = new Set<string>();
  function walkBody(body: string, bd: string): void {
    const inner = parseGameBody(body);
    const paths = collectIncludePathsFromStmts(inner, bd, packageRoot);
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

function evalEnv(ctx: Ctx): EvalEnv {
  return { chess: ctx.chess, cells: ctx.cells, registers: ctx.registers, resignLoser: ctx.resignLoser };
}

async function runIncludeBody(innerNorm: string, absPath: string, ctx: Ctx): Promise<PhaseRet> {
  if (ctx.includeChain.has(absPath)) {
    throw new Error(`Circular include: ${absPath}`);
  }
  const innerStmts = parseGameBody(innerNorm);
  ctx.includeChain.add(absPath);
  const prevBase = ctx.baseDir;
  ctx.baseDir = dirname(absPath);
  try {
    return await runStatements(innerStmts, ctx);
  } finally {
    ctx.baseDir = prevBase;
    ctx.includeChain.delete(absPath);
  }
}

async function execStmt(st: Stmt, ctx: Ctx): Promise<PhaseRet> {
  switch (st.kind) {
    case "fen": {
      if (ctx.fenSeen) throw new Error("Only one FEN line allowed per game (use a new game block).");
      ctx.fenSeen = true;
      ctx.chess.load(st.fen);
      return { kind: "ok" };
    }
    case "pgnHeader": {
      ctx.chess.setHeader(st.key, st.value);
      return { kind: "ok" };
    }
    case "directive": {
      const d = handleDirective(st.text, ctx);
      if (d.kind === "return") {
        return { kind: "return", value: d.value };
      }
      if (d.kind === "include") {
        const innerSource = readFileSync(d.absPath, "utf8");
        const innerNorm = preprocessSource(innerSource);
        assertIncludeSnippetOnly(innerNorm);
        return await runIncludeBody(innerNorm, d.absPath, ctx);
      }
      return { kind: "ok" };
    }
    case "move": {
      const m = doChessMove(ctx.chess, st.core);
      applyMoveMemory(ctx.cells, m);
      maybeTrace(ctx, m);
      applyMoveAnnotations(ctx, st.glyphs, st.nag);
      return { kind: "ok" };
    }
    case "if": {
      const take = evalExpr(st.cond, evalEnv(ctx)) !== 0;
      const branch = take ? st.then : st.elseSt;
      if (!branch) return { kind: "ok" };
      return await runStatements(branch, ctx);
    }
    case "while": {
      let n = 0;
      while (evalExpr(st.cond, evalEnv(ctx)) !== 0) {
        n++;
        if (n > MAX_LOOP) throw new Error("while: iteration limit exceeded");
        const r = await runStatements(st.body, ctx);
        if (r.kind === "return") return r;
        if (r.kind === "break") return { kind: "ok" };
        if (r.kind === "continue") continue;
      }
      return { kind: "ok" };
    }
    case "for": {
      let n = 0;
      if (st.from <= st.to) {
        for (let k = st.from; k <= st.to; k++) {
          n++;
          if (n > MAX_LOOP) throw new Error("for: iteration limit exceeded");
          ctx.registers.set(st.varName, k);
          const r = await runStatements(st.body, ctx);
          if (r.kind === "return") return r;
          if (r.kind === "break") return { kind: "ok" };
          if (r.kind === "continue") continue;
        }
      }
      return { kind: "ok" };
    }
    case "nestedGame": {
      const snap = takeSnapshot(ctx);
      try {
        const innerSt = parseGameBody(st.body);
        const p = await runStatements(innerSt, ctx);
        if (p.kind === "return") return p;
        if (p.kind === "break" || p.kind === "continue") {
          throw new Error(`${p.kind} used outside of a while/for loop`);
        }
        restoreSnapshot(ctx, snap);
        return { kind: "ok" };
      } catch (err) {
        restoreSnapshot(ctx, snap);
        throw err;
      }
    }
    case "nestedTournament": {
      await runTournamentParallel(st.mode, st.games, ctx.baseDir, ctx.packageRoot, ctx.quiet, ctx.trace);
      return { kind: "ok" };
    }
    case "break":
      return { kind: "break" };
    case "continue":
      return { kind: "continue" };
  }
}

async function runStatements(stmts: Stmt[], ctx: Ctx): Promise<PhaseRet> {
  for (const st of stmts) {
    const r = await execStmt(st, ctx);
    if (r.kind !== "ok") return r;
  }
  return { kind: "ok" };
}

function phaseToGameResult(p: PhaseRet): GameRunResult {
  if (p.kind === "return") {
    return { returned: true, value: p.value };
  }
  if (p.kind === "break" || p.kind === "continue") {
    throw new Error(`${p.kind} used outside of a while/for loop`);
  }
  return { returned: false, value: 0 };
}

function createCtx(
  baseDir: string,
  chain: Set<string>,
  packageRoot: string,
  quiet: boolean,
  traceDefault: boolean,
  extra?: { lineCapture?: string[]; forbidStdin?: boolean },
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
    lineCapture: extra?.lineCapture,
    forbidStdin: extra?.forbidStdin ?? false,
    resignLoser: undefined,
    variantProfile: "standard",
  };
}

async function runGameBody(
  body: string,
  baseDir: string,
  chain: Set<string>,
  packageRoot: string,
  quiet: boolean,
  traceDefault: boolean,
  extra?: { lineCapture?: string[]; forbidStdin?: boolean },
): Promise<GameRunResult> {
  const ctx = createCtx(baseDir, chain, packageRoot, quiet, traceDefault, extra);
  const stmts = parseGameBody(body);
  const p = await runStatements(stmts, ctx);
  return phaseToGameResult(p);
}

/** Payload and runner used by `tournament-worker.ts` (real parallelism). */
export type WorkerGamePayload = {
  body: string;
  baseDir: string;
  packageRoot: string;
  quiet: boolean;
  traceDefault: boolean;
};

export async function executeGameBodyInIsolation(payload: WorkerGamePayload): Promise<{
  returned: boolean;
  value: number;
  lines: string[];
}> {
  const lines: string[] = [];
  const r = await runGameBody(
    payload.body,
    payload.baseDir,
    new Set<string>(),
    payload.packageRoot,
    payload.quiet,
    payload.traceDefault,
    { lineCapture: lines, forbidStdin: true },
  );
  return { returned: r.returned, value: r.value, lines };
}

type WorkerResultMsg =
  | { ok: true; returned: boolean; value: number; lines: string[] }
  | { ok: false; error: string };

function workerExecArgv(): string[] {
  const a = [...process.execArgv];
  if (!a.includes("--experimental-strip-types")) {
    a.push("--experimental-strip-types");
  }
  return a;
}

function expectWorkerMessage(w: Worker): Promise<WorkerResultMsg> {
  return new Promise((resolve, reject) => {
    w.once("message", (msg: WorkerResultMsg) => resolve(msg));
    w.once("error", reject);
  });
}

async function runTournamentParallel(
  mode: "all" | "race",
  games: GameAst[],
  baseDir: string,
  packageRoot: string,
  quiet: boolean,
  traceDefault: boolean,
): Promise<void> {
  const workerPath = fileURLToPath(new URL("./tournament-worker.ts", import.meta.url));
  const workers = games.map(
    (g) =>
      new Worker(workerPath, {
        workerData: {
          body: g.body,
          baseDir,
          packageRoot,
          quiet,
          traceDefault,
        } satisfies WorkerGamePayload,
        execArgv: workerExecArgv(),
      }),
  );
  try {
    if (mode === "all") {
      const msgsRaw = await Promise.all(workers.map((w) => expectWorkerMessage(w)));
      const msgs: Extract<WorkerResultMsg, { ok: true }>[] = [];
      for (const m of msgsRaw) {
        if (!m.ok) throw new Error(m.error);
        msgs.push(m);
      }
      for (const msg of msgs) {
        if (!quiet) {
          for (const line of msg.lines) console.log(line);
        }
      }
      let sum = 0;
      let anyReturn = false;
      for (const msg of msgs) {
        if (msg.returned) {
          anyReturn = true;
          sum += msg.value;
        }
      }
      if (anyReturn) console.log(sum);
    } else {
      const promises = workers.map((w, i) => expectWorkerMessage(w).then((msg) => ({ i, msg })));
      const raced = await Promise.race(promises);
      for (let j = 0; j < workers.length; j++) {
        if (j !== raced.i) {
          workers[j].terminate();
          promises[j].catch(() => {});
        }
      }
      const msg = raced.msg;
      if (!msg.ok) throw new Error(msg.error);
      if (!quiet) {
        for (const line of msg.lines) console.log(line);
      }
      if (msg.returned) console.log(msg.value);
    }
  } finally {
    for (const w of workers) {
      try {
        await w.terminate();
      } catch {
        /* ignore */
      }
    }
  }
}

function emitGameResult(r: GameRunResult): void {
  if (r.returned) console.log(r.value);
}

export async function runProgram(source: string, options?: RunOptions): Promise<void> {
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
      const r = await runGameBody(item.body, baseDir, rootChain, packageRoot, quiet, traceDefault);
      emitGameResult(r);
    } else if (item.kind === "game") {
      const r = await runGameBody(item.body, baseDir, rootChain, packageRoot, quiet, traceDefault);
      emitGameResult(r);
    } else if (item.kind === "match") {
      let sum = 0;
      let anyReturn = false;
      for (const g of item.games) {
        const r = await runGameBody(g.body, baseDir, rootChain, packageRoot, quiet, traceDefault);
        if (r.returned) {
          anyReturn = true;
          sum += r.value;
        }
      }
      if (anyReturn) console.log(sum);
    } else if (item.kind === "tournament") {
      await runTournamentParallel(item.mode, item.games, baseDir, packageRoot, quiet, traceDefault);
    }
  }
}
