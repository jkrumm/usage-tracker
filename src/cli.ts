#!/usr/bin/env bun
import { dbPath, openDb } from "./db.ts";
import { runIngest } from "./ingest.ts";
import { formatSources, formatStats, sourceStatus, stats, type GroupBy } from "./report.ts";
import { sync } from "./sync.ts";

const HELP = `usage-tracker — local token/cost telemetry across AI tools

USAGE
  usage-tracker <command> [options]

COMMANDS
  ingest                 Run all available collectors incrementally (default)
    --full               Ignore watermarks and re-scan everything
    --source <name>      Only run one collector (claude-code|hermes|feuer|opencode)
  sync                   Push eligible usage_record rows to the Argo API
  stats                  Aggregated token + cost report (successful requests only)
    --by <dim>           Group by: source (default) | model | billing | day | machine | sub_tool
    --since <N>          Only the last N days
  sources                Per-collector status: rows, error rate, last run, last note
  help                   This message

ENV
  USAGE_DB       SQLite path (default ~/.local/share/usage-tracker/usage.db)
  USAGE_MACHINE  Override the machine label (default: macOS hardware model, e.g. "Mac mini (M2 Pro)")
  ARGO_URL       Argo API base URL (default https://argo.jkrumm.com/api)
  ARGO_TOKEN     Bearer token for Argo sync (if absent, sync is silently disabled)
  HERMES_DB      Override Hermes state.db path
  FEUER_DB       Override Feuer state.db path
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [, , cmdArg, ...rest] = process.argv;
  const cmd = cmdArg ?? "ingest";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const db = openDb();
  try {
    if (cmd === "ingest") {
      const results = await runIngest(db, {
        full: rest.includes("--full"),
        only: flag(rest, "--source"),
      });
      for (const r of results) {
        const detail = r.note ? ` (${r.note})` : "";
        process.stdout.write(
          `${r.source.padEnd(14)} ${r.status.padEnd(8)} +${r.newRows} new / ${r.processed} seen${detail}\n`,
        );
      }
      const failed = results.some((r) => r.status === "error");
      process.stdout.write(`\ndb: ${dbPath()}\n`);
      return failed ? 1 : 0;
    }

    if (cmd === "sync") {
      const { pushed, batches } = await sync(db);
      process.stdout.write(`sync: ${pushed} records pushed in ${batches} batch${batches === 1 ? "" : "es"}\n`);
      return 0;
    }

    if (cmd === "stats") {
      const by = (flag(rest, "--by") ?? "source") as GroupBy;
      const sinceRaw = flag(rest, "--since");
      const rows = stats(db, { by, sinceDays: sinceRaw ? Number(sinceRaw) : undefined });
      process.stdout.write(`${formatStats(rows, by)}\n`);
      return 0;
    }

    if (cmd === "sources") {
      process.stdout.write(`${formatSources(sourceStatus(db))}\n`);
      return 0;
    }

    process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
    return 2;
  } finally {
    db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
