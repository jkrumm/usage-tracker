import { SQL } from "bun";

// The usage schema lives in the `shared` database on the mini. USAGE_PG_URL wins; otherwise the URL is built
// from the `usage` role's password (secrets-run, never `op`: it hangs on a headless Mac). The URL carries the
// password, so it is never logged and errors name the cause, not the connection string.

const PASSWORD_REF = "op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD";

export function usagePgUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.USAGE_PG_URL) return env.USAGE_PG_URL;
  const proc = Bun.spawnSync(["secrets-run", "read", PASSWORD_REF], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const password = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 || !password) {
    throw new Error(`USAGE_PG_URL is unset and secrets-run could not read ${PASSWORD_REF} (exit ${proc.exitCode})`);
  }
  return `postgres://usage:${encodeURIComponent(password)}@127.0.0.1:5432/shared`;
}

export function connect(url: string = usagePgUrl()): SQL {
  return new SQL({ url, max: 4, connectionTimeout: 15 });
}
