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

  it("flow-demo.board (while)", () => {
    const out = runBoard("examples/flow-demo.board");
    strictEqual(out, "0");
  });

  it("tournament-demo.board (tournament all)", () => {
    const out = runBoard("examples/tournament-demo.board");
    strictEqual(out, "30");
  });

  it("tournament race returns first completion value", () => {
    const abs = join(root, "examples", "tournament-race-test.board");
    const r = spawnSync(
      node,
      ["--experimental-strip-types", cli, abs],
      { encoding: "utf8" },
    );
    strictEqual(r.status, 0, r.stderr || r.stdout);
    strictEqual((r.stdout ?? "").trimEnd(), "5");
  });

  it("tournament branch rejects read", () => {
    const abs = join(root, "examples", "tournament-read-error.board");
    const r = spawnSync(
      node,
      ["--experimental-strip-types", cli, abs],
      { encoding: "utf8" },
    );
    strictEqual(r.status, 1);
    strictEqual(r.stderr.includes("read"), true);
  });

  it("nested-game-snapshot restores registers", () => {
    const out = runBoard("examples/nested-game-snapshot.board");
    strictEqual(out, "0");
  });

  it("nested-game-return propagates return", () => {
    const out = runBoard("examples/nested-game-return.board");
    strictEqual(out, "0");
  });

  it("resign-outcome.board", () => {
    const out = runBoard("examples/resign-outcome.board");
    strictEqual(out, "-1");
  });

  it("move-annotations.board (NAG / check)", () => {
    const out = runBoard("examples/move-annotations.board");
    strictEqual(out, "1");
  });

  it("variant-chess960.board sets PGN Variant header", () => {
    const out = runBoard("examples/variant-chess960.board");
    strictEqual(out.includes("[Variant \"Chess960\"]"), true);
  });

  it("nested-tournament.board", () => {
    const out = runBoard("examples/nested-tournament.board");
    strictEqual(out, "12");
  });
});
