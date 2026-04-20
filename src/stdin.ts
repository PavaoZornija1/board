import { readSync } from "node:fs";

/** Read one line from fd 0 (blocking). Trims trailing newline; empty string on immediate EOF. */
export function readLineSyncFromStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(256);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (n === 0) break;
    const slice = buf.subarray(0, n);
    const nl = slice.indexOf(10);
    if (nl !== -1) {
      chunks.push(slice.subarray(0, nl));
      break;
    }
    chunks.push(Buffer.from(slice));
  }
  return Buffer.concat(chunks).toString("utf8").trimEnd();
}
