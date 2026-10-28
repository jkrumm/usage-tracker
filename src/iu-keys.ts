// The IU API keys we spend through. Each key has its own rolling 30-day cap in the
// IU self-service portal, so spend is split per key everywhere: usage_record.iu_key,
// the portal tables and the Argo payloads. Only labels live here, never key material.

export type IuKey = string;

export interface IuKeyDef {
  id: IuKey;
  label: string;
  /** op:// ref the portal scrape resolves via `secrets-run`; `account` is the 1Password account it lives in. */
  secretRef: string;
  account: "tkrumm" | "careerpartner";
  limitUsd: number;
}

export const DEFAULT_IU_KEY: IuKey = "personal";

export const IU_KEYS: readonly IuKeyDef[] = [
  { id: "personal", label: "Personal key", secretRef: "op://common/anthropic/API_KEY", account: "tkrumm", limitUsd: 500 },
  { id: "athena-team", label: "Athena team key", secretRef: "op://Private/athena-teamchat/key", account: "careerpartner", limitUsd: 500 },
];

/** Sources whose every IU call is made with one fixed key (the teamchat relay is its only holder). */
const SOURCE_KEYS: Readonly<Record<string, IuKey>> = {
  "athena-teamchat": "athena-team",
};

const known = new Set(IU_KEYS.map((k) => k.id));

/**
 * Rows of a non-default key are only pushed to Argo once Argo stores per-key data: before
 * that, an older Argo would file them under the personal key (portal rows would even
 * overwrite the personal cells of the same day and label, which feeds the cap). Off until
 * `USAGE_SYNC_IU_KEYS=1`; unsent rows stay queued, nothing is lost.
 */
export const syncNonDefaultKeys = (): boolean => process.env.USAGE_SYNC_IU_KEYS === "1";

/** A registered key id, or null (non-string, unknown id). Unknown ids are never invented into new keys. */
export function parseIuKey(value: unknown): IuKey | null {
  return typeof value === "string" && known.has(value) ? value : null;
}

export function iuKeyDef(id: IuKey): IuKeyDef | undefined {
  return IU_KEYS.find((k) => k.id === id);
}

/**
 * The key dimension, separate from billing: only `billing='iu'` rows have one
 * (every other row is NULL). Precedence: the key label the source's own line
 * carried (`raw.iuKey`, e.g. agent-workflows records which key a run used), then
 * the source's fixed key, else the personal key — the only one that existed before
 * the dimension, so every historical row means "personal".
 */
export function resolveIuKey(record: { source: string; billing: string; raw?: Record<string, unknown> }): IuKey | null {
  if (record.billing !== "iu") return null;
  return parseIuKey(record.raw?.iuKey) ?? SOURCE_KEYS[record.source] ?? DEFAULT_IU_KEY;
}
