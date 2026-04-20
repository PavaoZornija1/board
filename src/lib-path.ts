import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk upward from `startDir` until a directory containing `package.json` is found. */
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

export function resolveLibraryBoard(packageRoot: string, name: string): string {
  const safe = name.replace(/[/\\]/g, "");
  if (!safe) throw new Error("library name is empty");
  return join(packageRoot, "libraries", `${safe}.board`);
}
