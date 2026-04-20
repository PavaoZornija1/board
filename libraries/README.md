# Standard libraries

Files in this directory are loaded by the **`library <name>`** directive (or line `library "name"`), which resolves to `libraries/<name>.board` from the **package root** (the nearest `package.json` walking upward from your entry `.board` file).

Snippets here must follow the same rules as **`include`**: plain movetext and directives only—no top-level `game { }` or `match { }`.
