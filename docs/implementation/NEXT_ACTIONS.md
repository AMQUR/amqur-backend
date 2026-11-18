# NEXT_ACTIONS (checkpoint 2026-11-18)
Worktrees (untracked, in amqur-platform/): `wt-pr39` (#39), `wt-p1` (#40, Phase 1), `wt-p2` (#41, Phase 2a). Each has a node_modules symlink to `backend/node_modules` — do not commit. Disposable DB containers: `amqur-pgvector-test` (:55433), `amqur-plain-pg-test` (:55434).
1. Inspect CI on #39/#40/#41 (e2e-postgres was slow). Fix real failures.
2. Phase 2b: WorkflowRun/WorkflowStepRun models, human_review suspension that requires an authorized decision, run replay with redaction, tenant e2e.
3. Phase 1d: reranker, source inspector endpoint, file ingestion limits, conflict/stale detection.
4. Phase 3: Workflow Studio in `command-center/` against `ops/workflow-lab/definitions` (+ Playwright).
5. Phase 4: typed tool registry + approvals. 4a coded (mock providers, flags OFF); remaining: Command Center approval inbox UI, workflow tool node, consent-record linkage.
6. Owner: confirm pgvector on staging, set embedding key securely, review PRs.
Rollback: each PR additive; revert PR. #40 migration rollback SQL is in the migration header; #41 drops two tables + enum.
