# Puzzles

Informal challenges (no automated checker yet—use `npm run run -- your.board`).

1. **Return seven** — Write a single `game` that ends with `{return material}` or `{return cell …}` producing exactly `7` on stdout (no other lines except what your program needs).
2. **Assert mate** — After a known mating sequence, use `{assert gameover}` and `{assert check}` (or `{assert notcheck}` on the right side) so the program errors if the line is mistyped.
3. **Library vs include** — Same opening from `library foo` (under `libraries/`) and from `include "rel.board"` in one game; confirm both paths work from `examples/`.

Contributions welcome: add a `.board` solution under `examples/puzzles/` and describe it here.
