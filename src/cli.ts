#!/usr/bin/env node
/**
 * BoardLang CLI — see README.md and DOCUMENTATION.md.
 *
 * Flags may appear before or after the `.board` path: --help -h --quiet -q
 * --dry-run --print-ast --trace
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runProgram, type RunOptions } from "./runtime.ts";

function printHelp(): void {
  console.log(`board-lang — run a .board program

Usage:
  node --experimental-strip-types src/cli.ts [options] <file.board>
  board-lang [options] <file.board>   (when installed via npm bin)

Options:
  -h, --help       Show this help
  -q, --quiet      Suppress say, fen, trace, pgn, sayreg (returns / match sums still print)
  --dry-run        Parse and verify include/library files exist; no chess execution
  --print-ast      Print JSON document AST (exits after run unless combined with execution)
  --trace          Start each game with trace (fen) from the first move

Flags may be placed before or after the path to <file.board>.
`);
}

function parseArgs(argv: string[]): { path: string; opts: RunOptions } {
  let quiet = false;
  let dryRun = false;
  let printAst = false;
  let traceDefault = false;
  const pos: string[] = [];
  for (const a of argv) {
    if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    }
    if (a === "-q" || a === "--quiet") {
      quiet = true;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--print-ast") {
      printAst = true;
      continue;
    }
    if (a === "--trace") {
      traceDefault = true;
      continue;
    }
    if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    }
    pos.push(a);
  }
  if (pos.length !== 1) {
    console.error("Expected exactly one <file.board> argument.");
    printHelp();
    process.exit(1);
  }
  const abs = resolve(process.cwd(), pos[0]);
  return {
    path: abs,
    opts: { quiet, dryRun, printAst, traceDefault, sourcePath: abs },
  };
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  printHelp();
  process.exit(1);
}
const { path, opts } = parseArgs(argv);
const source = readFileSync(path, "utf8");
runProgram(source, opts);
