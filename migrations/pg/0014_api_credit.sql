-- API-credit billing and the inference gateway's two tables (agent-workflows docs/gateway.md §Usage and telemetry).
--
-- `api_credit`: a request paid from a Claude subscription's API credit (account iu|me|me2), neither the Max window
-- (`max`) nor the IU per-token key (`api_key`). The gateway writes usage.records rows straight to Postgres, so this
-- CHECK is its validator. Additive: the CHECKs are widened by name, no row changes.
ALTER TABLE usage.records  DROP CONSTRAINT records_billing_check;
ALTER TABLE usage.records  ADD  CONSTRAINT records_billing_check
  CHECK (billing IN ('max', 'api_key', 'api_credit', 'unknown'));
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

-- The gateway's routing decisions, modelled on usage.account_picks. picked is a pool id, 'iu' (passthrough) or
-- 'refused'; caller and session say who asked.
CREATE TABLE usage.gateway_picks (
  ts          timestamptz NOT NULL,
  caller      text        NOT NULL,
  session     text,
  picked      text        NOT NULL,
  reason      text        NOT NULL,
  machine     text        NOT NULL,
  request_id  text        NOT NULL,
  PRIMARY KEY (ts, caller, request_id)
);
