-- The Max-window series (decision U5). Mirrors SQLite quota_sample / account_pick, with real types.

-- One reading of an account's two Max windows. sampled_at is the observation time (now - cache age), so an
-- unchanged cached reading re-read on the next run collapses into the same row.
CREATE TABLE usage.quota_samples (
  account              text        NOT NULL,
  sampled_at           timestamptz NOT NULL,
  machine              text        NOT NULL,
  five_hour_pct        integer     CHECK (five_hour_pct BETWEEN 0 AND 100),
  seven_day_pct        integer     CHECK (seven_day_pct BETWEEN 0 AND 100),
  five_hour_resets_at  timestamptz,
  seven_day_resets_at  timestamptz,
  auth_ok              boolean,
  exhausted_until      timestamptz,
  source               text,
  PRIMARY KEY (account, sampled_at, machine)
);

-- The account picker's decisions (dotfiles claude-account pick). lane is the picker's own lane string, free text;
-- picked is an account id or the 'spill' sentinel; snapshot is the per-account {s,w} at pick time.
CREATE TABLE usage.account_picks (
  ts        timestamptz NOT NULL,
  lane      text        NOT NULL,
  picked    text        NOT NULL,
  reason    text        NOT NULL,
  stale     boolean     NOT NULL DEFAULT false,
  snapshot  jsonb,
  machine   text        NOT NULL,
  PRIMARY KEY (ts, lane, machine)
);
