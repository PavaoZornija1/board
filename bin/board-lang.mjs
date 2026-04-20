#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const cli = join(root, "..", "src", "cli.ts");
const r = spawnSync(
  process.execPath,
  ["--experimental-strip-types", cli, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(r.status === null ? 1 : r.status);
