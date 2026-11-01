-- API-credit billing and the inference gateway's two tables (agent-workflows docs/gateway.md §Usage and telemetry).
--
-- `api_credit`: a request paid from a Claude subscription's API credit (account iu|me|me2), neither the Max window
-- (`max`) nor the IU per-token key (`api_key`). The gateway writes usage.records rows straight to Postgres, so this
-- CHECK is its validator. Additive: the CHECKs are widened by name, no row changes.
--
-- Both tables are locked first, in the writer's order (sessions before records): the ALTERs take ACCESS EXCLUSIVE locks,
-- and taking them in the other order while an ingest holds sessions and waits for records would deadlock.
LOCK TABLE usage.sessions, usage.records IN ACCESS EXCLUSIVE MODE;

ALTER TABLE usage.records  DROP CONSTRAINT records_billing_check;
ALTER TABLE usage.records  ADD  CONSTRAINT records_billing_check
  CHECK (billing IN ('max', 'api_key', 'api_credit', 'unknown'));
-- The guard: a credit row always names its account and never carries an IU key (its spend is not the IU key's).
ALTER TABLE usage.records  ADD  CONSTRAINT records_api_credit_check
  CHECK (billing <> 'api_credit' OR (api_key IS NULL AND account IS NOT NULL));
ALTER TABLE usage.sessions DROP CONSTRAINT sessions_billing_check;
ALTER TABLE usage.sessions ADD  CONSTRAINT sessions_billing_check
  CHECK (billing IN ('max', 'api_key', 'api_credit', 'unknown'));

-- One credit cycle of an account: the grant, what we metered against it, and (once the cycle closed and the provider's
-- figure is known) the reconciled spend and the unspent remainder. cycle_end is NULL while the billing day is unknown.
CREATE TABLE usage.credit_cycles (
  account         text        NOT NULL,
  cycle_start     timestamptz NOT NULL,
  cycle_end       timestamptz,
  grant_usd       numeric     NOT NULL,
  metered_usd     numeric     NOT NULL,
  reconciled_usd  numeric,
  unspent_usd     numeric,
  closed_at       timestamptz,
  PRIMARY KEY (account, cycle_start)
);

-- The gateway's routing decisions, modelled on usage.account_picks. picked is a pool id, 'iu-api' (the IU passthrough; a pool
-- may itself be named 'iu') or 'refused'; caller and session say who asked. Keyed (request_id, picked): a request refused for
-- balance by a pool is re-picked, and both picks can share a millisecond ts; a request never picks the same target twice (refused
-- pools are excluded), so the key also keeps an idempotent re-flush from dropping the re-pick. gateway_picks_ts_idx serves time-range reads.
CREATE TABLE usage.gateway_picks (
  ts          timestamptz NOT NULL,
  caller      text        NOT NULL,
  session     text,
  picked      text        NOT NULL,
  reason      text        NOT NULL,
  machine     text        NOT NULL,
  request_id  text        NOT NULL,
  PRIMARY KEY (request_id, picked)
);
CREATE INDEX gateway_picks_ts_idx ON usage.gateway_picks (ts);
