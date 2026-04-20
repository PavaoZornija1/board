import { spawnSync } from "node:child_process";
import { strictEqual } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");
const node = process.execPath;

function runBoard(rel, extraArgs = []) {
  const abs = join(root, rel);
  const r = spawnSync(
    node,
    ["--experimental-strip-types", cli, ...extraArgs, abs],
    { encoding: "utf8" },
  );
  strictEqual(r.status, 0, r.stderr || r.stdout);
  return (r.stdout ?? "").trimEnd();
}

describe("golden examples", () => {
  it("hello.board", () => {
    const out = runBoard("examples/hello.board");
    strictEqual(out, "1\n1");
  });

  it("dry-run opening.board", () => {
    const out = runBoard("examples/opening.board", ["--dry-run"]);
    strictEqual(out, "dry-run ok");
  });

  it("print-ast is JSON", () => {
    const out = runBoard("examples/hello.board", ["--print-ast"]);
    const j = JSON.parse(out);
    strictEqual(Array.isArray(j), true);
    strictEqual(j[0].kind, "implicit");
  });

  it("library-demo.board", () => {
    const out = runBoard("examples/library-demo.board");
    strictEqual(out, "1");
  });

  it("gallery counter.board", () => {
    const out = runBoard("examples/gallery/counter.board");
    strictEqual(out, "3");
  });
});
