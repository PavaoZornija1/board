# BoardLang

**BoardLang** is an esoteric programming language where programs read like chess notation. Movetext is executed by a real chess rules engine ([chess.js](https://github.com/jhlywa/chess.js)); on top of that, the language maintains a separate **memory plane** on the 8×8 board and supports directives for I/O, tracing, early returns, and file includes.

Think of it as: *chess legality is the control structure; the score sheet is the source code.*

---

## Features

- **SAN or UCI moves** — Standard algebraic notation (what humans write on scoresheets) or engine-style coordinates.
- **Full chess rules** — Illegal moves are hard errors.
- **`game { }` / `match N { }` / `tournament all|race { }`** — One game, a sequential match, or **parallel** games (each branch runs in a **worker thread** with isolated board and memory; `{read}` is disallowed there).
- **Directives** — I/O (`say`, `fen`, `pgn`, `read`), tracing, **`return`**, **`resign`**, **`variant`**, **`assert`**, memory **`set`**, **named registers**, **`include`**, and **`library`** (loads from `libraries/*.board`).
- **Nested `game` / `tournament`** — Snapshot-and-restore nested **`game { }`**; **`tournament all|race`** inside a body uses the same worker model as at top level.
- **Move annotations** — Suffixes **`!!` `??` `!?` `?!` `!` `?`** and PGN **`$n`** NAGs (subset) for asserts / log lines after a legal move.
- **PGN tags** — Lines like `[Event "…"]` feed headers for `{pgn}` export.
- **Custom start** — `FEN "…"` once per game.
- **Control flow** — `if` / `else`, `while`, `for … from … to`, `break`, `continue`, plus nested **`game`** / **`tournament`**, with boolean / integer expressions (`reg`, `cell`, `material`, `check`, `side`, `gameover`, comparisons, `and` / `or` / `not`).
- **CLI** — `--quiet`, `--dry-run`, `--print-ast`, `--trace` (flags may appear before or after the file path).
- **Tooling** — `npm test`, global `board-lang` bin, VS Code grammar under `editor/boardlang-syntax/`, gallery and puzzle examples.

---

## Requirements

- [Node.js](https://nodejs.org/) **v22+** (uses `node --experimental-strip-types` to run TypeScript entrypoints without a separate compile step).

---

## Install and run

```bash
git clone <your-repository-url>
cd board
npm install
npm run run -- examples/hello.board
```

Use your real GitHub clone URL in place of `<your-repository-url>`.

The CLI resolves the entry file to an **absolute path** and passes it to the interpreter so **`include`** paths are resolved relative to that file’s directory.

---

## Minimal example

`examples/hello.board`:

```text
e4 e6
say e4
say e6
```

Run:

```bash
npm run run -- examples/hello.board
```

Output is two lines, each the memory value on the given square after the moves (see [DOCUMENTATION.md](DOCUMENTATION.md) for how memory updates work).

---

## Documentation

- **[DOCUMENTATION.md](DOCUMENTATION.md)** — Full syntax, semantics, and CLI.
- **[SPEC.md](SPEC.md)** — Short operational semantics sketch.

---

## Project layout

| Path | Role |
|------|------|
| `src/cli.ts` | CLI entry (`npm run run -- <file.board>`). |
| `src/interpreter.ts` | Execution: chess state, memory, directives, includes, libraries, match sums. |
| `src/parser.ts` | `game` / `match` parsing and game-body tokenization. |
| `src/square.ts` | Algebraic square ↔ memory index. |
| `libraries/*.board` | Optional standard snippets (`library name`). |
| `examples/` | Samples, `gallery/`, `puzzles/`. |
| `editor/boardlang-syntax/` | VS Code syntax extension (install from folder). |
| `bin/board-lang.mjs` | npm **`board-lang`** binary wrapper. |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run run -- <file.board>` | Run a BoardLang program. |
| `npm run check` | Syntax-check the CLI with Node. |
| `npm test` | Golden tests (`tests/golden.mjs`). |

### Global command (after `npm link` or install)

```bash
board-lang examples/hello.board
board-lang --dry-run examples/opening.board
```

---

## License

`chess.js` is [BSD-2-Clause](https://github.com/jhlywa/chess.js/blob/master/LICENSE). Add your own license for this repository when you publish (for example MIT), and keep the chess.js attribution as required by its license.
