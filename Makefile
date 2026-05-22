.PHONY: help install ingest backfill stats sources typecheck install-agent uninstall-agent logs

LABEL := com.jkrumm.usage-tracker

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dev dependencies
	bun install

ingest: ## Run incremental ingest across all sources
	bun run src/cli.ts ingest

backfill: ## Full re-scan of every source (ignores watermarks)
	bun run src/cli.ts ingest --full

stats: ## Token + cost report (override: make stats BY=model SINCE=7)
	bun run src/cli.ts stats $(if $(BY),--by $(BY)) $(if $(SINCE),--since $(SINCE))

sync: ## Push unsynced rows to the Argo API
	bun run src/cli.ts sync

sources: ## Per-collector status
	bun run src/cli.ts sources

typecheck: ## Type-check with tsc
	bun run tsc --noEmit

install-agent: ## Install + start the 15-min ingest LaunchAgent
	bash launchd/install-agent.sh

uninstall-agent: ## Stop + remove the LaunchAgent
	launchctl bootout gui/$$(id -u)/$(LABEL) 2>/dev/null || true
	rm -f $$HOME/Library/LaunchAgents/$(LABEL).plist
	@echo "removed $(LABEL)"

logs: ## Tail the LaunchAgent logs
	tail -f /tmp/usage-tracker.log /tmp/usage-tracker.err
