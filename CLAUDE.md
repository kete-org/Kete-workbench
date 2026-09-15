# CLAUDE.md

Context for Claude Code (or any AI assistant) working in this repository.
Read this fully before making changes. See also `ARCHITECTURE.md` and
`DECISIONS.md` for deeper background — this file stays short on purpose.

## What this repo is

Kete Workbench — a fork of `microsoft/vscode` with an embedded, governance-
aware coding agent, built for African developer economics (cost-tiered
model routing, offline-first, low-spec-hardware support). Currently in
Tier 0 (foundation): the editor shell is rebranded and packaged by CI, and
the governance gate service exists, but no agent loop has been built yet.

**"Kete Workbench" is the final product name** — decision closed, use it
everywhere (D-004 in `DECISIONS.md`, which also records the naming history).
A trademark search is still due before public launch; that's risk
mitigation, not naming uncertainty.

## Tech stack

- Electron + TypeScript (inherited from upstream VS Code)
- Node.js — **pinned to major version 24**, per `.nvmrc`. Mismatches throw
  a hard preinstall error by design (upstream's `build/npm/preinstall.ts`).
  Use `nvm use` before anything else in this repo.
- Build system: Gulp (`npm run gulp <task>`), not webpack/vite — this is
  inherited from upstream and not worth changing.
- Extension gallery: Open VSX (`https://open-vsx.org`), not Microsoft's
  marketplace — required for license compliance as a third-party fork.

## Common commands

```bash
nvm use                  # match the pinned Node version — do this first, always
npm ci                   # clean install; ~15-20 min on first run (native modules)
npm run compile          # compile TypeScript
./scripts/code.sh        # launch the editor (needs a display)
npm run eslint           # lint
node apply-product-json.ts product.json   # re-apply branding after an upstream sync
```

CI (`.github/workflows/build.yml`) runs on pull requests and pushes to `main`:
a fast Ubuntu compile/lint check plus native macOS arm64, macOS x64 and
Windows x64 packaging builds. `main` is protected — changes land through a
pull request with those checks passing (D-014). Never cross-compile platform
packages locally — build each on its native OS.

## Architecture (summary — see ARCHITECTURE.md for the full picture)

Everything funnels through one chokepoint: the **governance gate**. Order
of composition for any agent action: IDE shell → agent orchestrator →
governance gate (approval + audit log) → capability layer (model routing /
retrieval / tool & infra / skills & hooks) → integrations (MCP, Slack,
Teams, WhatsApp).

What exists today: the gate service, risk classifier and audit log in
`src/vs/platform/governance/`, called from the two call sites D-003 names —
`invokeTool` (gates every tool call, last check before it runs) and
`sendChatRequest` (records every model request). A tool call that needs
approval gets it through its own confirmation, which governance makes
un-skippable (`governedToolConfirmation.ts`), so the person is asked once.
Every decision goes to a durable, hash-chained audit store
(`governanceAuditStore.ts`); if it can't be written, the action is denied.
Both governance settings are policy-backed (`governanceConfiguration.ts`), and
policy can switch gating on but never off. Registration, the fallback dialog
and the audit sinks live in `src/vs/workbench/contrib/governance/`. Known
gaps: agent-host sessions bypass the gate, MCP tools default to `localWrite`,
and indirect commands (scripts, notebook cells) aren't inspected (D-016).
The inherited chat and tool-calling loop is upstream's; no Kete agent loop,
modes, skills or subagents exist yet.

## Hard rules — do not weaken these

- **Agent logic lives in the shared core, not in a platform client.** As
  the VS Code extension, JetBrains plugin, CLI, mobile app, and cloud
  runtime come online (see `MULTI_PLATFORM_PLAN.md`), none of them may
  reimplement orchestrator, governance-gate, or subagent logic locally.
  In the fork, the gate is the platform service in
  `src/vs/platform/governance/` (D-003); an extension never carries its own.
  If a feature only works in one client's codebase, that's a boundary
  bug, not a shipped feature.
- **No autonomous production changes without human sign-off.** Any code
  this repo ships must enforce approval gates for production-impacting
  actions (deploys, infra changes on shared/remote clusters, merges). This
  is a governance requirement carried over from established enterprise
  AI/vendor governance practice — not a style preference.
- **Telemetry is off by default** (`enableTelemetry: false` in
  `product.json`). Don't silently re-enable it or point it at a new
  endpoint without an explicit, documented opt-in mechanism.
- **Don't reintroduce Microsoft-specific endpoints** (`aiConfig`,
  `crashReporter`, the original `updateUrl`) when merging upstream changes
  — `apply-product-json.ts` removes these and restores the branding; re-run
  it after upstream syncs.
- **Local Docker/dev-only infra actions are low-friction; anything
  touching a remote/shared cluster goes through the same approval gate as
  code changes.** Don't build a shortcut around this distinction.

## Known gotchas

- **Node version**: `.nvmrc` pins major version 24. A mismatch fails loudly
  at `npm ci` — this is intentional upstream behavior, not a bug to work
  around.
- **`.js` files in this repo are ES modules** (`package.json` has
  `"type": "module"`) — any new CommonJS script needs a `.cjs` extension,
  or it throws `ReferenceError: require is not defined`.
- **`product.json.diff` is documentation, not a literal patch** — don't
  `git apply` it. Use `apply-product-json.ts` for actual changes, which
  patches by key and keeps upstream's tab formatting.
- **`product.json` still carries two upstream Microsoft hosts** —
  `voiceWsUrl` (`falcon-caas.mai.microsoft.com`) and the `vscode-cdn.net`
  webview URL. Open item; don't add more.
- **`build.yml` is the only workflow, on purpose.** Upstream syncs will try
  to bring back upstream's workflows, CodeQL and Dependabot config — keep
  them out.
- **Docs say "planned" until the code is merged** (D-015). Check the repo
  before describing a feature as present.
- **Icons are not yet replaced** — `resources/{darwin,win32,linux}/` still
  has upstream VS Code icon assets pending final branding artwork.

## Related docs

- `README.md` — project overview, status, and build steps
- `ARCHITECTURE.md` — full system architecture and the tiered feature roadmap
- `DECISIONS.md` — numbered decision log: naming, why VS Code was forked
  directly rather than via Cursor/Void, where the governance gate lives, and
  other decisions with their rationale
- `SETUP.md` — setup runbook for contributors
- `Kete_Workbench_Master_Roadmap.md` — one-document summary of the product
  roadmap; `ARCHITECTURE.md` and `DECISIONS.md` are authoritative where they
  differ
- `ENTERPRISE_OFFERING.md` — full Enterprise-tier feature spec, built
  from reviewing Kilo Code's and Qoder's actual Enterprise offerings
- `MULTI_PLATFORM_PLAN.md` — plan for shipping a lightweight VS Code
  extension, JetBrains plugin, CLI agent, mobile app, and cloud runtime
  as thin clients over the same agent core as the fork
- Harness.io integration (CI/CD status, SSCA for SBOM, feature flags,
  cost data, hook-compatible security analysis) is documented inline in
  `ARCHITECTURE.md`'s "Harness.io integration" section — not a separate
  file, since it's an integrations-layer addition, not a new architecture
  layer
