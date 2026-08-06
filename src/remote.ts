import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseMacModel } from "./machine.ts";
import type { Logger } from "./types.ts";

// The MacBook (ssh alias `iumac`) isn't a source of its own — it's a second
// filesystem root for the *existing* claude-code collector. Everything host-
// specific (the mirror location, the rsync invocations, the machine label for
// mirrored rows) lives here so claude-code.ts stays a plain two-root walker.
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
 * — see `logsOk` on SyncResult and collect() in claude-code.ts.
 */
export async function syncIumac(log: Logger): Promise<SyncResult> {
  if (iumacDisabled()) {
    log.info("iumac mirror: disabled via USAGE_IUMAC_DISABLE");
    return { ok: true, logsOk: true };
  }

  const logs = await syncLeg("logs", iumacLogsDir());
  const projects = await syncLeg("projects", iumacProjectsDir());

  if (!projects.ok) return { ok: false, note: projects.note, logsOk: logs.ok };
  if (!logs.ok) return { ok: false, note: logs.note, logsOk: false };
  return { ok: true, logsOk: true };
}

/** mkdir + rsync for one leg ("projects" or "logs"). Both steps are guarded. */
async function syncLeg(remoteSubdir: "projects" | "logs", destDir: string): Promise<LegResult> {
  try {
    mkdirSync(destDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, note: `iumac ${remoteSubdir} mkdir failed: ${msg}` };
  }
  return rsyncDir(remoteSubdir, destDir);
}

async function rsyncDir(remoteSubdir: "projects" | "logs", destDir: string): Promise<LegResult> {
  const host = iumacHost();
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
    `${host}:.claude/${remoteSubdir}/`,
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
      return { ok: false, note: `iumac ${remoteSubdir} rsync exit ${exitCode}${stderr ? ` — ${stderr}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, note: `iumac ${remoteSubdir} rsync failed: ${msg}` };
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
