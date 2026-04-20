# BoardLang — language documentation

This document is the **authoritative reference** for the BoardLang language as implemented in this repository. For a short overview and install instructions, see [README.md](README.md).

---

## 1. What BoardLang is

BoardLang is an **esoteric, interpreted** language:

1. **Chess layer** — A program manipulates a standard chess position using legal moves. Move notation is validated and applied by [chess.js](https://github.com/jhlywa/chess.js) (full rules: check, checkmate, stalemate, castling, en passant, promotion, draws where applicable, and so on).

2. **Memory layer** — Independently of the pieces, each of the 64 squares has an integer **cell** (initially `0`). Moves update these cells according to fixed rules (Section 6).

3. **Directives** — Side effects and control flow: printing, FEN dumps, tracing, ending a game with a numeric return value, and including other files.

Illegal chess moves, unknown directives, parse errors, and constraint violations (for example a second `FEN` line in the same game) cause **runtime errors** with a message; there is no undefined-move fallback.

---

## 2. Files and encoding

- Programs are conventionally stored in **`.board`** files (plain UTF-8 text).
- Line endings may be LF or CRLF.
- The reference implementation reads the file as UTF-8.

---

## 3. Top-level program shape

After **preprocessing** (Section 4), the parser decides between two modes.

### 3.1 Implicit single game

If the first meaningful content does **not** begin with the keywords `game` or `match` (case-insensitive), the **entire remainder** of the file (after preprocessing) is treated as **one game body** — the same content that would appear inside `game { … }`.

Use this for short scripts that are only movetext and directives.

**Restriction:** You cannot mix “bare movetext at the top” with later top-level `game { … }` or `match { … }` in the same file. If the file starts with `e4`, everything is implicit; a `game` block later in the file is **not** parsed as a separate construct.

### 3.2 Structured documents

If the file begins with `game` or `match`, the parser consumes a sequence of:

- **`game` optional-name `{` … `}`** — One game. `name` is an identifier (`[a-zA-Z_][a-zA-Z0-9_]*`) and is currently **not** used by the interpreter (reserved for future use, documentation, or tooling).

- **`match` positive-integer `{` … `}`** — A match containing exactly **N** nested **`game { … }`** blocks. The integer **N** must equal the number of `game` blocks inside the braces. Whitespace and `#` comments (Section 4) may appear between blocks.

Multiple top-level `game` blocks may appear in sequence without a `match` wrapper; they run one after another in file order.

---

## 4. Comments and preprocessing

### 4.1 Line comments with `#`

- If the first non-whitespace characters on a line form a **`#` comment** (line starts with optional whitespace then `#`), the whole line becomes empty for parsing purposes.
- Otherwise, a comment starts only at **whitespace followed by `#`** (`␠#` or `\t#`, and so on). Everything from that `#` to the end of the line is removed.

This rule exists so that **mate notation in SAN** (for example `Qxf7#`) is **not** mistaken for a comment: there is no space before `#`.

**Examples**

| Line (conceptually) | Effect |
|---------------------|--------|
| `# opening` | Entire line removed. |
| `e4 e5 # Italian` | Movetext `e4 e5` only. |
| `Qxf7#` | Kept verbatim for the move tokenizer. |

### 4.2 Preprocessor pass

Each line is stripped according to Section 4.1, then **trailing spaces** on that line are trimmed (end-of-line spaces removed). Newlines are preserved between lines for human readability only; game bodies are then split into lines again for tokenization.

Inside **`game` / `match` / `skipWsAndComments`** parsing, inline `#` is also treated as starting a comment to end of line when scanning for keywords and braces (same rule: avoid breaking `…#` in SAN).

---

## 5. Game body: tokens

A **game body** is a sequence of **tokens**, derived line by line (order preserved).

### 5.1 Whole-line forms

These forms consume the **entire** trimmed line (they must not share a line with other movetext, except leading/trailing space).

| Form | Meaning |
|------|---------|
| `FEN "…"` or `FEN '…'` | Load the given FEN string as this game’s position. **At most one** `FEN` line per game; a second one is an error. If omitted, the standard start position is used. |
| `say e4` (line only) | Directive equivalent to `{say e4}` (square in algebraic notation, `a1`–`h8`). |
| `include "path"` or `include 'path'` | Same as directive `{include "path"}` (Section 7). Quoted path only on this line form. |
| `library "name"` or `library name` | Same as `{library name}` (Section 11.5). |
| `[TagName "value"]` | PGN roster tag; sets a header for `{pgn}` (Section 12). |

`FEN` / `say` / `include` / `library` line matching is case-insensitive for the keyword where noted in the implementation; move SAN is handled by chess.js (pawn moves like `e4` are lowercase).

### 5.2 General lines

Any other non-empty trimmed line is tokenized by scanning left to right:

- **`{…}`** — A **directive**: the inner text is the directive string (leading/trailing spaces inside the braces are trimmed). **Nesting of `{` inside directives is not supported**; the first `}` ends the directive. Avoid `}` inside directive text.
- **Whitespace-separated words** — Each word that is not inside `…{ }…` becomes either a **move token** (SAN or UCI, Section 6) or, if it looks like a single token, is still passed to the move parser (invalid moves error).

Regex-wise, the implementation alternates `\{[^}]*\}` and `[^\s{}]+` per line.

---

## 6. Moves

### 6.1 SAN (standard algebraic notation)

Examples: `e4`, `Nf3`, `O-O`, `O-O-O`, `exd5`, `e8=Q`, `Nbd2`, `Qxf7#`.

Trailing **check/mate markers** `+` and `#` on the **end** of the token are stripped before calling chess.js, so `Nf3+` and mates with `#` work as expected.

### 6.2 UCI-like coordinates

A token matching (case-insensitive):

`[a-h][1-8][a-h][1-8][qrbn]?`

is interpreted as **from square**, **to square**, optional **promotion** piece (`q`/`r`/`b`/`n`). Example: `e2e4`, `e7e8q`.

### 6.3 Legality

Every move must be **legal** in the current position for the side to move. Otherwise chess.js throws and the program terminates with that error.

---

## 7. Directives

Directives are executed **in order** with moves and `FEN` loads. Unless stated otherwise, they do not end the game.

Further directives (**assert**, **set**, **read**, **registers**, **`{pgn}`**, **`library`**, **`--quiet`**) are documented in **Section 11**.

### 7.1 `{say <square>}` / line `say <square>`

Prints one line to stdout: the integer **memory cell** for that square (Section 8). Example: `{say e4}`.

### 7.2 `{fen}`

Prints one line: the current **FEN** string after all moves and loads applied so far in this game.

### 7.3 `{trace on}` / `{trace off}` / `{trace fen}` / `{trace san}`

- **`{trace on}`** or **`{trace}`** with no second word — Enable tracing; default mode is **fen**.
- **`{trace fen}`** — After each subsequent **move** (not after directives alone), print one line: `[trace] <fen>` using the position **after** that move.
- **`{trace san}`** — Same, but print `[trace] <SAN>` for the move that was just played.
- **`{trace off}`** — Disable tracing.

Tracing applies to moves executed in **included** snippets as well (same game context).

### 7.4 `{return outcome}`

- **Ends the game immediately** (no further tokens in that game run).
- Returns an integer printed by the host (Section 9):
  - If **checkmate**: `+1` if White won, `-1` if Black won (side to move is the mated side).
  - If the game is **over** but not checkmate (draw, stalemate, fifty-move, and so on): `0`.
- If the game is **not** over yet, this directive **throws** (it does not return a partial “outcome”).

### 7.5 `{return material}`

- Ends the game immediately.
- Returns **White material minus Black material** using these piece values: pawn `1`, knight `3`, bishop `3`, rook `5`, queen `9`, king `0`. Sum each side’s pieces on the board in the current position.

### 7.6 `{return cell <square>}` / `{return memory <square>}`

- Ends the game immediately.
- Returns the integer in the memory cell for that square (Section 8). No separate “piece value” is added unless your prior moves wrote it there.

### 7.7 `{return reg <name>}`

- Ends the game immediately.
- Returns the current value of register **name** (Section 11.2). Missing names are treated as `0`.

### 7.8 `{include "relative.board"}` / line `include "…"`

- **Inlines** another file: its contents are preprocessed and tokenized as a **game body** only, then executed **as if** its tokens were inserted at this point (same chess position, same memory cells, same trace flag).
- The path is **relative to `baseDir`**, which is the directory containing the **file that defined the current `baseDir`**. Initially that is the directory of the **entry** `.board` file. When a file is included, `baseDir` temporarily becomes that file’s directory for nested includes, then is restored.
- The included file **must not** be structured as a top-level `game` or `match` document: after preprocessing, if the trimmed text starts with `game` or `match`, the interpreter throws. Snippets should be plain movetext, `FEN`, directives, and further includes.
- **Circular includes** (including a file that is already on the include stack) throw.

Paths may be written in directives as:

- `include "path"` / `include 'path'`, or  
- `include path` (no spaces in path — one path token).

The line form `include "…"` requires quotes as in Section 5.1.

### 7.9 `library` (summary)

Line or brace form loads `libraries/<name>.board` from the package root; see **Section 11.5**.

---

## 8. Memory plane (formal rules)

There is one **integer array** of length 64 indexed by **square** (Section 8.1). All cells start at **0**.

Updates happen **after** a legal chess move is applied, using the **pretty** `Move` object from chess.js (`from`, `to`, capture flags, and so on).

### 8.1 Square indexing

Algebraic square `file` `a`–`h`, `rank` `1`–`8`. Index:

`index = (rank - 1) * 8 + (file - 'a')`

So `a1 → 0`, `h1 → 7`, `a2 → 8`, …, `h8 → 63`.

### 8.2 Quiet moves (non-capture, non-castling)

`cells[to] += 1`.

### 8.3 Captures (including normal captures, not en passant)

Let `from` and `to` be the move’s squares, **before** the in-memory update the captured piece sits on `to`.

`cells[to] = cells[from] + cells[to] + 1`

(The implementation reads prior `cells[from]` and `cells[to]` before overwriting `cells[to]`.)

### 8.4 En passant

The captured pawn is on square `(file of to, rank of from)` in algebraic form, for example `e5` when White plays `fxe6` ep.

`cells[to] += cells[from] + cells[capturedPawnSquare] + 1`  
`cells[capturedPawnSquare] = 0`

### 8.5 Castling

Treated as a quiet king move for the king destination, **then** the rook’s landing square is updated:

- **Kingside:** `cells[f1] += 1` (White) or `cells[f8] += 1` (Black).
- **Queenside:** `cells[d1] += 1` or `cells[d8] += 1`.

So the king square receives the quiet `+1`, and the rook square receives an additional `+1`.

### 8.6 Interaction with pieces

Memory cells are **not** tied to piece identity in the chess layer: moving a piece does not automatically clear `cells[from]`; only the rules above change values (captures and en passant clear the captured square as specified).

---

## 9. Return values and `match` aggregation

### 9.1 Single game (`implicit` or `game { … }`)

If the game body executes **`{return …}`**, the numeric value is printed on **one line** to stdout when that game finishes (only that line for the return; `say` / `fen` / `trace` print separately).

If no `{return …}` runs, nothing extra is printed for the return channel.

### 9.2 `match N { … }`

Each inner `game` runs in order with a **fresh** chess position and **fresh** memory (each game is isolated).

For every inner game that **did** execute `{return …}`, its value is added to a **sum**. If **at least one** inner game returned, the interpreter prints **one line**: that sum (games without `{return …}` contribute nothing to the sum, not even zero padding for missing returns).

If **no** inner game used `{return …}`, nothing is printed for the match aggregate.

---

## 10. Execution order (summary)

Within one game (including inlined bodies):

1. Tokens are processed strictly in order.
2. `FEN` loads replace the chess position (once).
3. Directives run immediately when seen (includes recurse; `{return}` stops the game). **PGN roster tags** (`[Event "…"]`, and so on) apply `setHeader` when their token is processed.
4. Move tokens update chess, then memory, then optional trace output.

---

## 11. Extended directives

### 11.1 Memory and stdin

| Directive | Meaning |
|-----------|---------|
| `{set <sq> <n>}` | Set memory cell at square to integer **n** (overwrites). |
| `{read <sq>}` | Read **one line** from standard input (blocking), parse as base-10 integer, store in cell at **sq**. The line must be a valid integer (no extra junk). |

### 11.2 Registers (named integers per game)

Registers are scoped to **one game** (each `game { … }` or implicit file starts empty). Names match `[a-zA-Z_][a-zA-Z0-9_]*`.

| Directive | Meaning |
|-----------|---------|
| `{let <name> <n>}` | Set register **name** to **n**. |
| `{inc <name>}` | Increment by 1. |
| `{dec <name>}` | Decrement by 1. |
| `{add <name> <n>}` | Add **n** to register. |
| `{sayreg <name>}` | Print register value (respects `--quiet`). |
| `{return reg <name>}` | End game; return value is register **name** (missing names count as `0`). |

### 11.3 Assertions

All failures throw and stop the program.

| Directive | Condition required |
|-----------|-------------------|
| `{assert check}` | Side to move is in check. |
| `{assert notcheck}` | Side to move is **not** in check. |
| `{assert gameover}` | Position is game-over (mate, stalemate, draw rule, and so on). |
| `{assert side white}` / `{assert side black}` | Side to move is White / Black (`w` / `b` aliases allowed). |

### 11.4 PGN export

| Directive | Meaning |
|-----------|---------|
| `{pgn}` | Print the current game as a PGN string (headers from `[Tag "value"]` lines plus movetext). Respects `--quiet`. |

### 11.5 Standard libraries

| Form | Meaning |
|------|---------|
| `library "name"` / `library name` / `{library name}` | Load **`libraries/<name>.board`** under the **package root** (nearest `package.json` found walking upward from the entry file’s directory). Same execution rules as **`include`** (snippet only, shared chess + memory state). |

### 11.6 Quiet mode

When **`--quiet`** is passed to the CLI (or you wire `quiet: true` in `RunOptions`), these produce **no** stdout: `{say}`, `{fen}`, `{pgn}`, `{trace}` lines, `{sayreg}`. **`{return …}`** values and **`match`** aggregate sums **still print** (treated as primary program output).

### 11.7 Includes and preprocessing

The top-level document is preprocessed for `#` comments before parsing. **Included** and **library** files are also run through the same preprocessor **before** tokenization, so line comments behave the same as in the main file.

---

## 12. PGN tag lines

A whole line matching PGN roster form:

`[TagName "value"]`

sets a header on the chess instance (`setHeader`). Standard backslash escapes inside the value: `\"` → `"`, `\\` → `\`.

---

## 13. Command-line interface

Invoked as:

`node --experimental-strip-types src/cli.ts [options] <file.board>`

or, after `npm install -g .` or local `npm link`, as:

`board-lang [options] <file.board>`

| Option | Effect |
|--------|--------|
| `-h`, `--help` | Usage text; exit `0`. |
| `-q`, `--quiet` | Quiet mode (Section 11.6). |
| `--dry-run` | Parse document, resolve **`include`** / **`library`** targets, verify files exist; **no** moves executed. Prints `dry-run ok`. |
| `--print-ast` | Print `JSON.stringify(parseDocument(source), null, 2))`. If **`--dry-run`** is also set, runs after AST print; then **`--dry-run`** exits without running moves. If only **`--print-ast`**, exits after printing (no execution). |
| `--trace` | Equivalent to starting each game with `{trace fen}` active before the first token. |

Flags may appear **before or after** the path to `<file.board>`.

---

## 14. Tests, `bin`, and editor grammar

- **`npm test`** — Runs `node --test tests/*.mjs` (golden checks on sample programs).
- **`npm` `bin`** — Field **`board-lang`** points at `bin/board-lang.mjs`, which spawns Node with `--experimental-strip-types` on `src/cli.ts`.
- **VS Code** — Under `editor/boardlang-syntax/` is a small extension (grammar + `language-configuration.json`). Install with **Extensions → Install from VSIX…** after packaging, or run **Developer: Install Extension from Location…** and pick that folder. See `editor/boardlang-syntax/README.md`.

---

## 15. Formal sketch

A one-page operational semantics (configurations and transitions) lives in [SPEC.md](SPEC.md).

---

## 16. API (embedding)

```ts
import { runProgram, type RunOptions } from "./src/runtime.ts";

runProgram(sourceString, {
  sourcePath: "/absolute/path/to/entry.board",
  quiet: false,
  dryRun: false,
  printAst: false,
  traceDefault: false,
});
```

- **`sourcePath`**: Recommended for **`include`** / **`library`** resolution. Should be **absolute**. If omitted, `baseDir` defaults to `process.cwd()`.

---

## 17. Implementation notes

- **Runtime:** Node.js with `--experimental-strip-types` on `.ts` sources (no emit step in `npm run run`).
- **Chess:** [chess.js](https://www.npmjs.com/package/chess.js) v1.x.
- **Errors:** Invalid SAN/UCI, illegal moves, unknown directives, bad FEN, include violations, assert failures, and brace parse errors surface as JavaScript `Error` messages with stack traces.

---

## 18. Example index (this repo)

| File | Illustrates |
|------|-------------|
| `examples/hello.board` | Implicit game, SAN, `say`. |
| `examples/opening.board` | Named `game`, `{say …}`. |
| `examples/match.board` | `match` with two games, no returns. |
| `examples/match-return.board` | `{return outcome}` and `{return material}` summed. |
| `examples/from-fen.board` | `FEN "…"` line. |
| `examples/trace.board` | `{trace fen}` / `{trace off}`. |
| `examples/fen-directive.board` | `{fen}`. |
| `examples/with-include.board` | Line `include "…"`. |
| `examples/snippet-sicilian.board` | Snippet included by another file. |
| `examples/library-demo.board` | `library sicilian` from `libraries/`. |
| `examples/gallery/counter.board` | `let` / `inc` / `sayreg`. |
| `examples/gallery/tags.board` | PGN tags + `{pgn}`. |
| `examples/read-demo.board` | `{read e4}` — pipe one integer line on stdin, then `say e4`. |

See also `examples/gallery/README.md` and `examples/puzzles/README.md`.

---

## 19. Versioning

The language is **0.x** and may evolve. This document matches the **current** tree when committed; for older behavior, use the repository history.

If you extend the language, append a **Changelog** section here or add `CHANGELOG.md` and link it from [README.md](README.md).
