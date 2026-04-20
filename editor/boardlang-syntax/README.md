# BoardLang syntax highlighting (VS Code)

This folder is a minimal **Visual Studio Code** extension that adds TextMate grammar for `.board` files.

## Install from source (no VSIX)

1. Open VS Code.
2. **Developer: Install Extension from Location…**
3. Choose this directory: `editor/boardlang-syntax` (the folder that contains `package.json`).

Reload the window. Open any `*.board` file and pick language mode **BoardLang** if it does not auto-detect.

## Package as VSIX (optional)

With [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce) installed:

```bash
cd editor/boardlang-syntax
npx @vscode/vsce package
```

Then install the generated `.vsix` from the VS Code Extensions view.

## Limits

The grammar is **approximate**: it does not validate chess legality or nested `{}` inside directives. It exists to make reading and editing programs more pleasant.
