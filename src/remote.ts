import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseMacModel } from "./machine.ts";
import type { Logger } from "./types.ts";

// The MacBook (ssh alias `iumac`) isn't a source of its own — it's a second
// filesystem root for the *existing* claude-code and codex collectors.
// Everything host-specific (the mirror location, the rsync invocations, the
// machine label for mirrored rows) lives here so each collector stays a plain
// two-root walker.
//
// Why mirror rather than read over ssh live: listJsonl/byte-offset resume
// needs a real local path, and a local mirror lets a dead/asleep MacBook
// degrade to "stale data, keep going" instead of "collector blocks or errors".
//
// Why one `source = "claude-code"` and not a second collector: collector_state
// is keyed by source, so a second collector sharing the name would collide on
// its cursor row; and the cursor itself is a `Record<absolutePath, offset>`,
// so mirrored files are simply new keys in the same map — no cursor-format
// change needed. Rows are told apart by the `machine` column instead (see
// types.ts UsageRecord.machine and db.ts upsertRecords).

function iumacHost(): string {
  return process.env.USAGE_IUMAC_HOST?.trim() || "iumac";
}

function remoteRoot(): string {
  return (
    process.env.USAGE_REMOTE_DIR?.trim() || join(homedir(), ".local", "share", "usage-tracker", "remote")
  );
}

function mirrorRoot(): string {
  return join(remoteRoot(), "iumac");
}

/** Local mirror of iumac's `~/.claude/projects`. Passed to the same listJsonl walker as the local root. */
export function iumacProjectsDir(): string {
  return join(mirrorRoot(), "projects");
}

/** Local mirror of iumac's `~/.claude/logs` (session_env lines for billing classification). */
export function iumacLogsDir(): string {
  return join(mirrorRoot(), "logs");
}

/**
 * Local mirror of iumac's `~/.codex/sessions` — the MacBook's Codex CLI
 * rollout JSONL, walked by codex.ts the same way it walks its local root.
 * Not under ~/.claude at all, unlike the other two legs — see rsyncDir's
 * per-leg remote path.
 */
export function iumacCodexDir(): string {
  return join(mirrorRoot(), "codex-sessions");
}

/**
 * Local mirror of iumac's `~/.local/share/usage-tracker` — the MacBook's
 * one-shot jsonl logs (astra.jsonl, sideclaw-iu.jsonl, …), walked by astra.ts
 * the same way it walks its local root. That remote directory also holds a
 * stale, decommissioned (2026-07-27) `usage.db` (+ WAL/SHM siblings) from
 * when the MacBook itself ran usage-tracker directly; rsyncDir's shared
 * `--include=*.jsonl` / `--exclude=*` filter (the same one every other leg
 * already uses) already excludes anything that isn't `*.jsonl`, so no
 * leg-specific filter override is needed to keep that DB off this machine.
 */
export function iumacUsageJsonlDir(): string {
  return join(mirrorRoot(), "usage-jsonl");
}

/** Hard off switch: when set, no ssh/rsync call is made at all. */
export function iumacDisabled(): boolean {
  return process.env.USAGE_IUMAC_DISABLE === "1";
}

/**
 * True when the logs mirror already has at least one previously-synced
 * session_env file on disk, independent of whether *this* run's logs leg
 * succeeded. collect() uses this to tell "logs failed but we have at-most-
 * one-run-stale (15 min) data to classify against" — fine, advance transcript
 * offsets — from "the logs mirror has never synced anything at all" —
 * advancing there would mean those transcript bytes can never be classified
 * correctly, ever, so the offset has to be withheld instead.
 */
export function hasMirroredLogs(): boolean {
  const dir = iumacLogsDir();
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

export interface SyncResult {
  ok: boolean;
  /** Present on failure; a short, log-friendly reason. */
  note?: string;
  /**
   * Outcome of the logs leg specifically, independent of `ok` (which reflects
   * the whole sync). collect() in claude-code.ts needs this on its own: a
   * failed logs leg means newly mirrored transcripts may get classified
   * against stale/absent session_env data, and once their byte offset
   * advances that data can never be re-read — so the decision to advance
   * mirror offsets hinges on this leg alone, not on whether projects also
   * synced fine.
   */
  logsOk: boolean;
  /**
   * Outcome of the codex-sessions leg specifically. Deliberately never folded
   * into `ok` or `note` the way projects/logs are: syncIumac's only call site
   * is claude-code.ts's collect(), so a codex-mirror failure flipping that
   * unrelated collector's `ok` (and overwriting its `note`) would misattribute
   * the failure and could demote an otherwise-healthy claude-code run. A codex
   * leg failure degrades the same way a logs failure degrades for its own
   * consumer — its own flag, checked by its own reader (codex.ts) — rather
   * than the way a projects failure degrades (the whole sync reported failed).
   * It's logged here regardless, so it's never silent even without an `ok`
   * flip.
   */
  codexOk: boolean;
  /**
   * Outcome of the usage-jsonl leg specifically (astra.jsonl and any sibling
   * one-shot jsonl logs mirrored from iumac's ~/.local/share/usage-tracker).
   * Deliberately never folded into `ok` or `note`, for the same reason as
   * `codexOk`: syncIumac's only call site is claude-code.ts's collect(), so a
   * usage-jsonl-mirror failure flipping that unrelated collector's `ok` (and
   * overwriting its `note`) would misattribute the failure and could demote
   * an otherwise-healthy claude-code run. It degrades the same way codexOk
   * degrades — its own flag, checked by its own reader (astra.ts) — rather
   * than the way a projects failure degrades (the whole sync reported
   * failed). It's logged here regardless, so it's never silent even without
   * an `ok` flip.
   */
  usageJsonlOk: boolean;
}

interface LegResult {
  ok: boolean;
  /** Present on failure; a short, log-friendly reason. */
  note?: string;
}

// BatchMode=yes guarantees ssh never prompts (no password, no host-key
// interaction) — a hung prompt would otherwise wedge the whole ingest run.
// ConnectTimeout bounds only the TCP handshake; --timeout on rsync itself
// bounds the transfer, and Bun's spawn `timeout` is the last-resort kill
// switch if both of those somehow don't fire.
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
const RSYNC_TIMEOUT_S = 60;
const SPAWN_PATH = `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`;

/**
 * Mirror iumac's transcripts + session logs into the local mirror root via
 * rsync. Never throws — a stale-or-absent MacBook must never block local
 * ingest, and that includes the mkdirSync calls below, not just the rsync
 * spawn: a permission error or a non-directory occupying the mirror path
 * would otherwise propagate straight out of this function. `--delete` is
 * deliberate: it bounds mirror disk use and keeps it honest, and a file
 * disappearing mid-mirror is harmless because its cursor entry (keyed by
 * absolute mirror path) simply stops matching anything.
 *
 * Logs sync before projects (not the reverse) so the logs leg's own outcome
 * is known before the caller decides whether transcript offsets may advance
 * — see `logsOk` on SyncResult and collect() in claude-code.ts. The codex and
 * usage-jsonl legs run last: nothing gates on their outcome, they only need
 * to happen and be reported on their own `codexOk`/`usageJsonlOk` flags (see
 * each field's doc comment).
 */
export async function syncIumac(log: Logger): Promise<SyncResult> {
  if (iumacDisabled()) {
    log.info("iumac mirror: disabled via USAGE_IUMAC_DISABLE");
    return { ok: true, logsOk: true, codexOk: true, usageJsonlOk: true };
  }

  const logs = await syncLeg("logs", iumacLogsDir());
  const projects = await syncLeg("projects", iumacProjectsDir());
  const codex = await syncLeg("codex", iumacCodexDir());
  if (!codex.ok) log.warn(`iumac mirror: ${codex.note}`);
  const usageJsonl = await syncLeg("usage-jsonl", iumacUsageJsonlDir());
  if (!usageJsonl.ok) log.warn(`iumac mirror: ${usageJsonl.note}`);

  if (!projects.ok) {
    return { ok: false, note: projects.note, logsOk: logs.ok, codexOk: codex.ok, usageJsonlOk: usageJsonl.ok };
  }
  if (!logs.ok) {
    return { ok: false, note: logs.note, logsOk: false, codexOk: codex.ok, usageJsonlOk: usageJsonl.ok };
  }
  return { ok: true, logsOk: true, codexOk: codex.ok, usageJsonlOk: usageJsonl.ok };
}

type Leg = "projects" | "logs" | "codex" | "usage-jsonl";

// Only the codex and usage-jsonl legs live outside ~/.claude on the remote —
// everything else about the four legs (mkdir, rsync flags, failure handling)
// is identical, so this is the one place a leg's remote path is allowed to
// differ.
const REMOTE_SUBDIR: Record<Leg, string> = {
  projects: ".claude/projects",
  logs: ".claude/logs",
  codex: ".codex/sessions",
  "usage-jsonl": ".local/share/usage-tracker",
};

/** rsync exit 23 whose stderr names a missing source path — an absent month. */
function isMissingSource(note: string | undefined): boolean {
  return !!note && note.includes("rsync exit 23") && note.includes("No such file or directory");
}

/**
 * Sub-paths to sync for a leg, relative to both REMOTE_SUBDIR[leg] and the
 * local mirror dir. `[""]` means "the whole tree", which is what every leg
 * except codex uses.
 *
 * Codex is the exception, and the reason is the link, not the data. The
 * MacBook reaches this host over a Tailscale DERP relay (Frankfurt, ~120ms
 * RTT, `direct connection not established` — measured 2026-09-10), and rsync
 * costs several round trips per file. Its rollout tree is 1,187 files, so a
 * full-tree sync spends minutes and reliably trips rsync's own inactivity
 * --timeout mid-transfer; a manual run moved 273 of 1,187 files in 2m41s
 * before dying on `poll: timeout`. Remote traversal is NOT the bottleneck
 * (`find` over the same tree returns in 0.5s) — per-file latency is.
 *
 * `~/.codex/sessions` is date-bucketed as YYYY/MM/DD, so scoping the recurring
 * sync to the current and previous month turns 1,187 files into a handful:
 * cheap enough to survive the relay, and it still picks up the moment Codex
 * is used on the MacBook again. Anything older is historical and static —
 * previous month stays in the list for a full month after it ends, so a month
 * boundary loses nothing.
 *
 * Deliberately NOT backfilled: the MacBook's 1,187 archived rollouts (Nov 2025
 * – Mar 2026) were pulled once with a tar pipe and scanned — they contain ZERO
 * ingestable rows. They predate the Codex CLI build that writes
 * `payload.usage` / `payload.response_id`, so they carry no token counts at
 * all. Walking them every run would cost 1,187 stats for nothing. The leg
 * exists for FUTURE `cx` use on the MacBook, not for history.
 */
function legSubPaths(leg: Leg): string[] {
  if (leg !== "codex") return [""];
  const now = new Date();
  const month = (d: Date) =>
    `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [month(prev), month(now)];
}

/**
 * mkdir + rsync for one leg. Both steps are guarded. A leg with several
 * sub-paths (codex) syncs each in turn and reports the first failure; a
 * missing remote month is not a failure, so `--ignore-missing-args`-style
 * tolerance is handled by rsync exit 23/24 being surfaced as-is in the note
 * rather than special-cased — the leg's flag is advisory anyway.
 */
async function syncLeg(leg: Leg, destDir: string): Promise<LegResult> {
  for (const sub of legSubPaths(leg)) {
    const dest = sub ? join(destDir, sub) : destDir;
    try {
      mkdirSync(dest, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, note: `iumac ${leg} mkdir failed: ${msg}` };
    }
    const result = await rsyncDir(leg, dest, sub);
    // A month with no Codex activity simply has no directory on the MacBook,
    // and rsync calls that exit 23 ("partial transfer due to error", with a
    // `(l)stat: No such file or directory` on the source). That is the normal
    // state for a machine that has not run `cx` this month, not a failure —
    // treat it as success so a quiet month cannot mark the leg unhealthy.
    if (!result.ok && !isMissingSource(result.note)) return result;
  }
  return { ok: true };
}

async function rsyncDir(leg: Leg, destDir: string, sub = ""): Promise<LegResult> {
  const host = iumacHost();
  const remote = sub ? `${REMOTE_SUBDIR[leg]}/${sub}` : REMOTE_SUBDIR[leg];
  const args = [
    "rsync",
    "-a",
    "--delete",
    `--timeout=${RSYNC_TIMEOUT_S}`,
    "-e",
    `ssh ${SSH_OPTS.join(" ")}`,
    "--include=*/",
    "--include=*.jsonl",
    "--exclude=*",
    `${host}:${remote}/`,
    `${destDir}/`,
  ];
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      // Belt-and-braces: rsync's own --timeout should always fire first, this
      // is only the fallback if the process wedges some other way.
      timeout: (RSYNC_TIMEOUT_S + 15) * 1000,
      killSignal: "SIGKILL",
      env: { ...process.env, PATH: SPAWN_PATH },
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim().split("\n")[0];
      return { ok: false, note: `iumac ${leg}${sub ? `/${sub}` : ""} rsync exit ${exitCode}${stderr ? ` — ${stderr}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, note: `iumac ${leg} rsync failed: ${msg}` };
  }
}

let cachedLabel: string | null = null;

/**
 * Machine label for rows mirrored from iumac. Precedence: `USAGE_IUMAC_MACHINE`
 * env override > a label cached at `<mirror>/machine` from a previous probe >
 * a fresh `system_profiler` probe over ssh (cached to disk once it succeeds) >
 * the literal "iumac" if the probe fails or is disabled. Never throws, never
 * blocks ingest on a dead MacBook.
 */
export async function iumacMachineLabel(): Promise<string> {
  if (cachedLabel !== null) return cachedLabel;

  const cacheFile = join(mirrorRoot(), "machine");
  const envLabel = process.env.USAGE_IUMAC_MACHINE;
  const diskLabel = readCachedLabel(cacheFile);

  // Only probe when neither faster source answered — the whole point of the
  // disk cache is to make the ssh round-trip a one-time cost.
  const shouldProbe = !envLabel?.trim() && !diskLabel && !iumacDisabled();
  const probedLabel = shouldProbe ? await probeIumacModel() : null;

  cachedLabel = resolveIumacLabel({ envLabel, diskLabel, probedLabel });
  if (shouldProbe && probedLabel) writeCachedLabel(cacheFile, probedLabel);
  return cachedLabel;
}

/**
 * Pure precedence resolver, split out from iumacMachineLabel so the ordering
 * (env > disk cache > probe > literal fallback) is unit-testable without
 * touching ssh, rsync or the filesystem.
 */
export function resolveIumacLabel(opts: {
  envLabel: string | undefined;
  diskLabel: string | null;
  probedLabel: string | null;
}): string {
  const env = opts.envLabel?.trim();
  if (env) return env;
  if (opts.diskLabel) return opts.diskLabel;
  if (opts.probedLabel) return opts.probedLabel;
  return "iumac";
}

function readCachedLabel(cacheFile: string): string | null {
  if (!existsSync(cacheFile)) return null;
  try {
    const label = readFileSync(cacheFile, "utf-8").trim();
    return label || null;
  } catch {
    return null;
  }
}

function writeCachedLabel(cacheFile: string, label: string): void {
  try {
    mkdirSync(mirrorRoot(), { recursive: true });
    writeFileSync(cacheFile, label);
  } catch {
    // best-effort cache; a failed write just means we probe again next run
  }
}

async function probeIumacModel(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ssh", ...SSH_OPTS, iumacHost(), "system_profiler", "SPHardwareDataType"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
      env: { ...process.env, PATH: SPAWN_PATH },
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const out = await new Response(proc.stdout).text();
    return parseMacModel(out);
  } catch {
    return null;
  }
}
