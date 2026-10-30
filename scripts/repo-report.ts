// Read-only: run normalizeRepo over every distinct `project` in the SQLite staging DB and report what the
// slugs would look like. Usage: bun run scripts/repo-report.ts [path-to-usage.db]
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeRepo } from "../src/repo.ts";

const path = process.argv[2] ?? process.env.USAGE_DB ?? join(homedir(), ".local/share/usage-tracker/usage.db");
const db = new Database(path, { readonly: true });
const rows = db
  .query("SELECT project, COUNT(*) AS n FROM usage_record GROUP BY project ORDER BY n DESC")
  .all() as { project: string | null; n: number }[];

const repos = new Map<string, { rows: number; inputs: number }>();
const unmapped: { project: string | null; n: number }[] = [];
let total = 0;
let nullRows = 0;
for (const { project, n } of rows) {
  total += n;
  const repo = normalizeRepo(project);
  if (repo === null) {
    nullRows += n;
    unmapped.push({ project, n });
    continue;
  }
  const agg = repos.get(repo) ?? { rows: 0, inputs: 0 };
  agg.rows += n;
  agg.inputs += 1;
  repos.set(repo, agg);
}

const pct = (n: number) => `${((100 * n) / total).toFixed(2)}%`;
const out: string[] = [];
out.push(`rows ${total}, distinct raw project values ${rows.length}`);
out.push(`distinct repos ${repos.size} (iu/ namespace: ${[...repos.keys()].filter((r) => r.startsWith("iu/")).length})`);
out.push(`rows with repo NULL: ${nullRows} (${pct(nullRows)}) from ${unmapped.length} distinct inputs`);
out.push("", "top 25 repos (rows, distinct raw inputs folded in)");
for (const [repo, a] of [...repos].sort((x, y) => y[1].rows - x[1].rows).slice(0, 25)) {
  out.push(`  ${String(a.rows).padStart(7)}  ${String(a.inputs).padStart(4)}  ${repo}`);
}
out.push("", "20 most frequent NULL inputs");
for (const u of unmapped.slice(0, 20)) out.push(`  ${String(u.n).padStart(7)}  ${u.project === null ? "(null)" : JSON.stringify(u.project)}`);
const pathLike = unmapped.filter((u) => u.project && /\/(SourceRoot|IuRoot)(\/|$)/.test(u.project));
out.push("", `NULL inputs that sit under SourceRoot/IuRoot (${pathLike.length}); top 10:`);
for (const u of pathLike.slice(0, 10)) out.push(`  ${String(u.n).padStart(7)}  ${JSON.stringify(u.project)}`);
process.stdout.write(`${out.join("\n")}\n`);
