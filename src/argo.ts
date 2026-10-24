import { log } from "./log.ts";

export interface ArgoConfig {
  url: string;
  token: string;
}

/** Argo connection settings, or null when sync is disabled (no ARGO_TOKEN). */
export function argoConfig(): ArgoConfig | null {
  const token = process.env.ARGO_TOKEN;
  if (!token) return null;
  return { url: process.env.ARGO_URL ?? "https://argo.jkrumm.com/api", token };
}

export type PostResult = "ok" | "missing" | "failed";

/**
 * POST a JSON body to Argo. 2xx = "ok". With `tolerateMissing`, a 404/405
 * (endpoint not shipped yet) is "missing" and logged at info; otherwise — and for
 * every other failure, including network errors — it is "failed" and logged as an error.
 */
export async function postJson(
  cfg: ArgoConfig,
  path: string,
  body: unknown,
  opts: { tolerateMissing?: boolean } = {},
): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log.error(`sync failed: ${path} network error: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
  if (res.ok) return "ok";
  if (opts.tolerateMissing && (res.status === 404 || res.status === 405)) {
    log.info(`sync: ${path} not available on Argo yet (HTTP ${res.status}); rows stay unsynced`);
    return "missing";
  }
  const text = (await res.text()).slice(0, 400);
  log.error(`sync failed: ${path} HTTP ${res.status} ${res.statusText} — ${text}`);
  return "failed";
}
