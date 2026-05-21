import type { Logger } from "./types.ts";

// Minimal stderr logger. stdout is reserved for CLI report output so it stays
// pipeable; everything diagnostic goes to stderr.
export const log: Logger = {
  info: (m) => process.stderr.write(`${ts()} info  ${m}\n`),
  warn: (m) => process.stderr.write(`${ts()} warn  ${m}\n`),
  error: (m) => process.stderr.write(`${ts()} error ${m}\n`),
};

function ts(): string {
  return new Date().toISOString();
}
