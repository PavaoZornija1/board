# BoardLang — operational sketch

This is a compact **operational semantics** sketch for the reference interpreter, not a complete formal proof. For the user-facing language, see [DOCUMENTATION.md](DOCUMENTATION.md).

---

## Configurations

A **configuration** for one game (or one inlined snippet continuation) is:

\[
C = \langle \mathit{ch},\ \mathit{mem},\ \mathit{regs},\ \mathit{pc},\ \sigma \rangle
\]

- **ch** — chess.js position (board, side, castling, EP, clocks, headers, history).
- **mem** — map \( \mathit{Sq} \to \mathbb{Z} \) (the 64 memory cells; implemented as `Int32Array`).
- **regs** — map \( \mathit{Name} \to \mathbb{Z} \) (registers for the current game).
- **pc** — program counter over the **token stream** (FEN lines, PGN tags, directives, moves, and expanded include bodies as a flat list).
- **σ** — auxiliary: trace on/off, trace mode, `fenSeen` flag, `baseDir` for includes, `packageRoot` for libraries, include stack for cycle detection, `quiet` flag.

**Initial configuration** (start of each `game` / implicit file): standard chess start unless the first `FEN` token changes it; all `mem` and `regs` zeroed; `fenSeen` false; trace off unless CLI `--trace`; `pc` at first token.

---

## Transitions (informal)

- **FEN token** — If `fenSeen` is false, `chess.load(fen)`; set `fenSeen`. If already true, **error**.
- **PGN header token** — `chess.setHeader(key, value)`.
- **Directive** — Dispatch on first word (say, fen, pgn, trace, return, assert, set, read, let, inc, dec, add, sayreg, include, library). Side effects update `mem`, `regs`, `σ`, or stdout. **`return`** builds a terminal value and **stops** the game configuration (no further tokens in that game).
- **Include / library** — Push file onto include stack; read and **preprocess** text; parse tokens; recurse the same transition relation; pop stack and restore `baseDir` on exit. **`return` inside include** propagates as end-of-outer-game.
- **Move token** — Let \(m = \mathit{chess.move}(\mathit{tok})\). If illegal, **error**. Else update `mem` with the rules in DOCUMENTATION §8 (quiet, capture, en passant, castling). If trace on, append trace line to stdout (unless `quiet`).

**Match** semantics: run a sequence of games; each game gets a **fresh** \(C_0\). If any game ends in a **`return`**, sum those values and print one line.

---

## Observable output

Stdout is the concatenation (in order) of:

- Lines from `{say}`, `{fen}`, `{pgn}`, `{sayreg}`, trace lines, and numeric **`return`** / **match** lines, subject to **`quiet`** suppressing everything except **`return`** and **match** sums (as implemented).

Stderr is unused on success; errors throw through Node.

---

## Notes

- **Turing-completeness** is not claimed here: chess is finite; with only finitely many positions the bare position is not an unbounded store. **`mem`**, **registers**, and **`read`** provide an unbounded integer plane in principle, but total program execution is still bounded by your patience and disk. A serious computability discussion would fix an encoding and a complexity class separately.
