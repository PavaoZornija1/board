import { SQUARES, type Chess } from "chess.js";
import { squareToIndex } from "./square.ts";

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export type EvalEnv = {
  chess: Chess;
  cells: Int32Array;
  registers: Map<string, number>;
  /** Side that resigned (terminal without chess.js game-over). */
  resignLoser?: "w" | "b";
};

export type ExprAst =
  | { kind: "lit"; value: number }
  | { kind: "reg"; name: string }
  | { kind: "cell"; sq: string }
  | { kind: "material" }
  | { kind: "check" }
  | { kind: "notcheck" }
  | { kind: "gameover" }
  | { kind: "notgameover" }
  | { kind: "side"; color: "w" | "b" }
  | { kind: "not"; inner: ExprAst }
  | { kind: "bin"; op: "==" | "!=" | "<" | ">" | "<=" | ">="; left: ExprAst; right: ExprAst }
  | { kind: "and"; left: ExprAst; right: ExprAst }
  | { kind: "or"; left: ExprAst; right: ExprAst };

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

function truthy(n: number): boolean {
  return n !== 0;
}

export function evalExpr(e: ExprAst, env: EvalEnv): number {
  switch (e.kind) {
    case "lit":
      return e.value;
    case "reg":
      return env.registers.get(e.name) ?? 0;
    case "cell":
      return env.cells[squareToIndex(e.sq)];
    case "material":
      return materialDiff(env.chess);
    case "check":
      return env.chess.inCheck() ? 1 : 0;
    case "notcheck":
      return env.chess.inCheck() ? 0 : 1;
    case "gameover":
      return env.chess.isGameOver() || env.resignLoser !== undefined ? 1 : 0;
    case "notgameover":
      return env.chess.isGameOver() || env.resignLoser !== undefined ? 0 : 1;
    case "side":
      return env.chess.turn() === e.color ? 1 : 0;
    case "not":
      return truthy(evalExpr(e.inner, env)) ? 0 : 1;
    case "and":
      return truthy(evalExpr(e.left, env)) && truthy(evalExpr(e.right, env)) ? 1 : 0;
    case "or":
      return truthy(evalExpr(e.left, env)) || truthy(evalExpr(e.right, env)) ? 1 : 0;
    case "bin": {
      const a = evalExpr(e.left, env);
      const b = evalExpr(e.right, env);
      switch (e.op) {
        case "==":
          return a === b ? 1 : 0;
        case "!=":
          return a !== b ? 1 : 0;
        case "<":
          return a < b ? 1 : 0;
        case ">":
          return a > b ? 1 : 0;
        case "<=":
          return a <= b ? 1 : 0;
        case ">=":
          return a >= b ? 1 : 0;
        default:
          return 0;
      }
    }
    default:
      return 0;
  }
}

type Tok =
  | { kind: "num"; n: number }
  | { kind: "id"; name: string }
  | { kind: "op"; op: string }
  | { kind: "lp" }
  | { kind: "rp" }
  | { kind: "eof" };

function tokenizeExpr(src: string): Tok[] {
  const s = src.trim();
  const out: Tok[] = [];
  let i = 0;

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const c = s[i];
    if (c === "(") {
      out.push({ kind: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ kind: "rp" });
      i++;
      continue;
    }
    if (c === "<" && s[i + 1] === "=") {
      out.push({ kind: "op", op: "<=" });
      i += 2;
      continue;
    }
    if (c === ">" && s[i + 1] === "=") {
      out.push({ kind: "op", op: ">=" });
      i += 2;
      continue;
    }
    if (c === "=" && s[i + 1] === "=") {
      out.push({ kind: "op", op: "==" });
      i += 2;
      continue;
    }
    if (c === "!" && s[i + 1] === "=") {
      out.push({ kind: "op", op: "!=" });
      i += 2;
      continue;
    }
    if ("<>".includes(c)) {
      out.push({ kind: "op", op: c });
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && i + 1 < s.length && /[0-9]/.test(s[i + 1]))) {
      let neg = false;
      if (c === "-") {
        neg = true;
        i++;
      }
      const start = i;
      while (i < s.length && /[0-9]/.test(s[i])) i++;
      let n = Number(s.slice(start, i));
      if (neg) n = -n;
      out.push({ kind: "num", n });
      continue;
    }
    if (!/[a-zA-Z_]/.test(c)) throw new Error(`Bad char in expression: ${c} at ${i} in ${JSON.stringify(src)}`);
    const start = i;
    while (i < s.length && /[a-zA-Z0-9_]/.test(s[i])) i++;
    const name = s.slice(start, i).toLowerCase();
    if (name === "and" || name === "or" || name === "not") {
      out.push({ kind: "id", name });
      continue;
    }
    if (name === "true") {
      out.push({ kind: "num", n: 1 });
      continue;
    }
    if (name === "false") {
      out.push({ kind: "num", n: 0 });
      continue;
    }
    out.push({ kind: "id", name });
  }
  out.push({ kind: "eof" });
  return out;
}

class P {
  toks: Tok[];
  i = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(): Tok {
    return this.toks[this.i] ?? { kind: "eof" };
  }
  eat(): Tok {
    return this.toks[this.i++] ?? { kind: "eof" };
  }
}

function parseExprAst(src: string): ExprAst {
  const p = new P(tokenizeExpr(src));
  const e = parseOr(p);
  if (p.peek().kind !== "eof") throw new Error(`Extra tokens in expression: ${src}`);
  return e;
}

function parseOr(p: P): ExprAst {
  let left = parseAnd(p);
  while (p.peek().kind === "id" && (p.peek() as Extract<Tok, { kind: "id" }>).name === "or") {
    p.eat();
    const right = parseAnd(p);
    left = { kind: "or", left, right };
  }
  return left;
}

function parseAnd(p: P): ExprAst {
  let left = parseNot(p);
  while (p.peek().kind === "id" && (p.peek() as Extract<Tok, { kind: "id" }>).name === "and") {
    p.eat();
    const right = parseNot(p);
    left = { kind: "and", left, right };
  }
  return left;
}

function parseNot(p: P): ExprAst {
  if (p.peek().kind === "id" && (p.peek() as Extract<Tok, { kind: "id" }>).name === "not") {
    p.eat();
    return { kind: "not", inner: parseNot(p) };
  }
  return parseCmp(p);
}

function parseCmp(p: P): ExprAst {
  let left = parsePrimary(p);
  const pk = p.peek();
  if (pk.kind === "op") {
    const opStr = (p.eat() as { kind: "op"; op: string }).op;
    if (!["==", "!=", "<", ">", "<=", ">="].includes(opStr)) throw new Error(`Bad operator ${opStr}`);
    const right = parsePrimary(p);
    return { kind: "bin", op: opStr as "==" | "!=" | "<" | ">" | "<=" | ">=", left, right };
  }
  return left;
}

function parsePrimary(p: P): ExprAst {
  const t = p.peek();
  if (t.kind === "num") {
    p.eat();
    return { kind: "lit", value: t.n };
  }
  if (t.kind === "lp") {
    p.eat();
    const inner = parseOr(p);
    if (p.peek().kind !== "rp") throw new Error("Expected )");
    p.eat();
    return inner;
  }
  if (t.kind !== "id") throw new Error(`Unexpected token in expression`);
  p.eat();
  const id = t.name;
  if (id === "material") return { kind: "material" };
  if (id === "check") return { kind: "check" };
  if (id === "notcheck") return { kind: "notcheck" };
  if (id === "gameover") return { kind: "gameover" };
  if (id === "notgameover") return { kind: "notgameover" };
  if (id === "reg") {
    const nm = p.peek();
    if (nm.kind !== "id") throw new Error("Expected register name after reg");
    p.eat();
    return { kind: "reg", name: nm.name };
  }
  if (id === "cell") {
    const sq = p.peek();
    if (sq.kind !== "id") throw new Error("Expected square after cell");
    p.eat();
    if (!/^[a-h][1-8]$/.test(sq.name)) throw new Error(`Bad square: ${sq.name}`);
    return { kind: "cell", sq: sq.name };
  }
  if (id === "side") {
    const col = p.peek();
    if (col.kind !== "id") throw new Error("Expected white|black after side");
    p.eat();
    const c = col.name;
    if (c === "white" || c === "w") return { kind: "side", color: "w" };
    if (c === "black" || c === "b") return { kind: "side", color: "b" };
    throw new Error(`Expected white|black after side, got ${c}`);
  }
  throw new Error(`Unknown primary in expression: ${id}`);
}

export function parseExpr(src: string): ExprAst {
  return parseExprAst(src);
}