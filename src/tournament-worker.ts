/**
 * Worker entry: runs one game body in isolation (see executeGameBodyInIsolation).
 */
import { parentPort, workerData } from "node:worker_threads";
import { executeGameBodyInIsolation, type WorkerGamePayload } from "./interpreter.ts";

async function main(): Promise<void> {
  const data = workerData as WorkerGamePayload;
  try {
    const result = await executeGameBodyInIsolation(data);
    parentPort?.postMessage({ ok: true as const, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ ok: false as const, error: message });
  }
}

void main();
