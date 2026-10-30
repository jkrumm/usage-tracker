.PHONY: help install pg-migrate prices-sync prices-seed-history install-prices-agent uninstall-prices-agent test budget iu-portal iu-portal-setup iu-portal-login ingest backfill ingest-iumac stats sources billing-audit relane typecheck check deploy verify install-agent uninstall-agent logs

LABEL := com.jkrumm.usage-tracker
PRICES_LABEL := com.jkrumm.usage-tracker-prices

# Tests need an admin Postgres connection in USAGE_TEST_PG_URL (scratch databases usage_test_<random>). Unset on the
# mini, it is built from .env.test.tpl through secrets-run; without secrets-run the Postgres suites skip visibly.
# ARGS (make test ARGS=src/prices) reaches the shell as an environment variable, never spliced into the command text.
export ARGS
define RUN_TESTS
@if [ -n "$$USAGE_TEST_PG_URL" ] || ! command -v secrets-run >/dev/null 2>&1; then \
	bun test $$ARGS; \
else \
	secrets-run run --env-file=.env.test.tpl -- sh -c \
		'USAGE_TEST_PG_URL="postgres://$$(bun -e "process.stdout.write(encodeURIComponent(process.env.USAGE_TEST_PG_USER))"):$$(bun -e "process.stdout.write(encodeURIComponent(process.env.USAGE_TEST_PG_PASSWORD))")@127.0.0.1:5432/postgres" exec bun test $$ARGS'; \
fi
endef

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dev dependencies
	bun install

ingest: ## Run incremental ingest across all sources
	bun run src/cli.ts ingest

backfill: ## Full re-scan of every source (ignores watermarks)
	bun run src/cli.ts ingest --full

ingest-iumac: ## Force-refresh the iumac mirror and run claude-code ingest only
	bun run src/cli.ts ingest --source claude-code

stats: ## Token + cost report (override: make stats BY=model SINCE=7)
	bun run src/cli.ts stats $(if $(BY),--by $(BY)) $(if $(SINCE),--since $(SINCE))

sync: ## Push unsynced rows to the Argo API
	bun run src/cli.ts sync

reprice: ## Re-cost stored rows against the current pricing table (DRYRUN=1, MODEL=<norm>)
	bun run src/cli.ts reprice $(if $(MODEL),--model $(MODEL)) $(if $(DRYRUN),--dry-run)

relane: ## Backfill claude-code sub_tool from transcript entrypoints (DRYRUN=1)
	bun run src/cli.ts relane $(if $(DRYRUN),--dry-run)

IU_PORTAL_DIR := .local/share/iu-portal/tool

budget: ## IU cap per key (rolling 30 days): portal cost vs limit, drop-off, portal vs tracked (KEY=<id>, MODEL=<norm> explains one model per day)
	bun run src/cli.ts budget $(if $(KEY),--key $(KEY)) $(if $(MODEL),--explain $(MODEL))

iu-portal: ## Fetch the IU portal cost report now (via iumac, ignores the 4 h throttle)
	bun run src/cli.ts iu-portal

iu-portal-setup: ## Sync tools/iu-portal to iumac and install its dependencies
	ssh iumac 'mkdir -p ~/$(IU_PORTAL_DIR)'
	rsync -a --delete --exclude node_modules --exclude '*.test.ts' --exclude fixture.ts tools/iu-portal/ iumac:$(IU_PORTAL_DIR)/
	ssh iumac 'cd ~/$(IU_PORTAL_DIR) && bun install'

iu-portal-login: ## Re-run the IU portal sign-in headed on the MacBook (approve the dialog there)
	~/SourceRoot/dotfiles/scripts/ask-human.sh ask 'Sign in to the IU cost portal (Chrome opens on this Mac; finish Entra/Okta within 5 minutes)' --wait 330 --cmd 'cd ~/$(IU_PORTAL_DIR) && /opt/homebrew/bin/bun scrape.ts --login'

sources: ## Per-collector status
	bun run src/cli.ts sources

billing-audit: ## Per-session claude-code billing check vs. the live session_env log
	bun run src/cli.ts billing-audit $(if $(SINCE),--since $(SINCE)) $(if $(SESSION),--session $(SESSION))

typecheck: ## Type-check with tsc
	bun run tsc --noEmit

test: ## Run the test suite (Postgres suites need secrets-run or USAGE_TEST_PG_URL)
	$(RUN_TESTS)

check: typecheck ## All local validation: type-check, then run the test suite
	$(RUN_TESTS)

pg-migrate: ## Apply migrations/pg to the usage schema (USAGE_PG_URL, default role usage on shared)
	bun run src/cli.ts pg-migrate

prices-sync: ## Write usage.prices rows for aliased models whose catalog price changed
	bun run src/cli.ts prices-sync

prices-seed-history: ## One-off: seed usage.prices from LiteLLM's git history (SINCE=YYYY-MM-DD)
	bun run src/cli.ts prices-seed-history $(if $(SINCE),--since $(SINCE))

install-prices-agent: ## Install the daily prices-sync LaunchAgent, 04:20 (does not touch the ingest agent)
	bash launchd/install-prices-agent.sh

uninstall-prices-agent: ## Stop + remove the prices-sync LaunchAgent
	launchctl bootout gui/$$(id -u)/$(PRICES_LABEL) 2>/dev/null || true
	rm -f $$HOME/Library/LaunchAgents/$(PRICES_LABEL).plist $$HOME/.local/state/jobs/$(PRICES_LABEL).json
	@echo "removed $(PRICES_LABEL)"

install-agent: ## Install + start the 15-min ingest LaunchAgent
	bash launchd/install-agent.sh

deploy: install-agent ## Ship the default branch: (re)install + kickstart the LaunchAgent

verify: ## Probe the running LaunchAgent + source freshness (exit 0 = loaded, log fresh, no stale source)
	@launchctl print gui/$$(id -u)/$(LABEL) >/dev/null 2>&1 || { echo "verify: $(LABEL) not loaded"; exit 1; }
	@log="$$HOME/Library/Logs/usage-tracker.log"; \
	  [ -f "$$log" ] || { echo "verify: $$log missing"; exit 1; }; \
	  age=$$(( $$(date +%s) - $$(stat -f %m "$$log") )); \
	  [ "$$age" -le 1800 ] || { echo "verify: last output $${age}s old (limit 1800s)"; exit 1; }; \
	  echo "verify: $(LABEL) loaded, last output $${age}s ago"
	@bun run src/cli.ts health

health: ## Fail when a source's newest row is older than its expected cadence
	bun run src/cli.ts health

uninstall-agent: ## Stop + remove the LaunchAgent
	launchctl bootout gui/$$(id -u)/$(LABEL) 2>/dev/null || true
	rm -f $$HOME/Library/LaunchAgents/$(LABEL).plist $$HOME/.local/state/jobs/$(LABEL).json
	@echo "removed $(LABEL)"

logs: ## Tail the last 50 lines of the LaunchAgent logs (~/Library/Logs, never /tmp)
	tail -n 50 $$HOME/Library/Logs/usage-tracker.log $$HOME/Library/Logs/usage-tracker.err
