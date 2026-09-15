# Architecture

## System overview

Every agent action flows through one chokepoint by design:

```
IDE shell (this repo)
    ↓
Agent orchestrator      (plan → act → observe loop)
    ↓
Governance gate         (approval gates + audit log)
    ↓
Capability layer        (peers, called as needed, not a strict hierarchy)
    ├── Model routing         (local Ollama / cloud Claude API / other providers)
    ├── Retrieval             (hybrid: vector search + code graph + knowledge base)
    ├── Tool & infra layer    (read/edit/run/git + Docker/Kubernetes provisioning)
    └── Skills & hooks        (progressive-disclosure skill loading, lifecycle hooks)
    ↓
Integrations             (MCP, Slack, Teams, WhatsApp, Jira/Linear/Confluence, Harness.io)
```

The governance gate is the single reason every capability (model calls,
tool execution, infra provisioning, skill installation) is auditable and
interruptible in one place, rather than each subsystem enforcing its own
rules independently. **This must not be bypassable by project-level
config** — governance policy sits above `.ide-config.json` in precedence.

Where it lives (D-003): a platform service in `src/vs/platform/governance/`,
called from the two chokepoints every tool call and model request already
passes through — `ILanguageModelToolsService.invokeTool` and
`ILanguageModelsService.sendChatRequest`. Both call sites are wired: a tool
call is authorized as the last step before it runs, and a model request is
recorded before it reaches the provider. When a tool call needs approval, its
own confirmation (in chat, or the dialog when there is no chat session) is
that approval: it can't be auto-approved, and the person is asked once. Every
decision is written to a durable, append-only audit store with a hash chain;
an action whose decision can't be written is denied. The threshold and on/off
switch are policy-backed settings, and policy can switch gating on but never
off (D-016). The workbench registers the gate, a fallback approval dialog and
the audit sinks in `src/vs/workbench/contrib/governance/`.
Agent features and UI ride on top as bundled extensions that call into the
gated APIs and never carry a gate of their own: `extensions/kete-agent` (the
`@kete` agent loop, project rules and prompt layers, D-018) and
`extensions/kete-models` (model providers and the Kete Auto router, D-017).
Kete Auto re-sends every attempt through `vscode.lm`, so each concrete model
call passes `sendChatRequest` and is audited under its real model id.

## Prompt composition (lives inside the agent orchestrator)

The "system prompt" is layered, assembled fresh per request, additive-and-
minimal (only relevant layers included, to keep the local-model fast path
cheap):

1. Core system prompt — shipped with the product, versioned like code
2. Governance policy overlay — org-level rules, admin-set, not project-overridable
3. Project rules — `.ide-config.json`, versioned with the repo
4. Mode-specific prompt — Plan/Code/Debug/Ask
5. Active skill instructions — only skills matched to the current task
6. Subagent-specific prompt — swapped in only for that subagent's isolated context
7. Retrieved context — pulled live from the retrieval layer, not a prompt but composed alongside one

## Feature roadmap by tier

### Tier 0 — Foundation (current phase)
VS Code fork, agent orchestrator (adopt the chat and tool-calling loop
inherited from upstream rather than building one — D-003), tool layer,
diff/edit UI and checkpointing (both inherited), macOS+Windows CI matrix,
code signing,
project rules file, governance approval gates + audit log, dual-mode
online/offline model routing, tiered model routing + self-hosted
inference, context efficiency (AST chunking, caching), offline request
queue, SSH remote dev (no Tailscale; Microsoft's Remote-SSH isn't on Open
VSX, so this needs an open-source implementation — D-005).

### Tier 1 — Core differentiators
Skills loader (`SKILL.md` standard) + curated starter pack, hybrid
retrieval indexing, hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`), security subagent, regression testing
subagent (invoked via a flexible `/review` command — uncommitted, branch,
commit hash, or PR reference, not just a single "run review" action),
plan mode + named modes (Plan/Code/Debug/Ask — no dedicated
"Orchestrator" mode, and no separate "Architect" mode either, since it
described the same thing as Plan under a different name; see design note
below), Slack + Teams integration,
environment/infra subagent (Docker/Kubernetes/Supabase/Redis
provisioning), secrets vault, per-tool governance permissions
(`read`/`edit`/`bash`/etc. individually allow/ask/deny — a planned rework
of today's risk tiers in `src/vs/platform/governance/`, see D-006),
context/token usage timeline in the chat panel
(session activity by type, token budget with a warning past 50% used),
snapshot/revert UX (git-based, revert any message's changes directly from
chat, with a banner when viewing an earlier state).

### Tier 2 — Strong second wave
MCP connector gateway (the MCP client itself is inherited from upstream —
D-003), Repo Wiki, prompt-to-UI subagent + Figma
integration + design tokens, background/cloud agents, persistent cross-
session memory, documentation/code-review/API-contract/dependency-license
subagents, automated commit/PR descriptions, in-IDE CI/CD status,
enterprise controls — SSO, SCIM, group-based permissions, model policy
controls, private model gateway, shared spend pool, plugin/skill
distribution management, private capability marketplace (full spec in
`ENTERPRISE_OFFERING.md`), DB schema
visualizer, API test/mock panel, observability panel, IaC generation +
cost estimation, WhatsApp + SMS-fallback notifications, org-wide code
search, Jira/Linear/Confluence sync, admin/telemetry dashboard, Enhance
Prompt (rewrites a rough prompt before sending), Session Goals (explicit
tracked objectives distinct from the running conversation), message-level
feedback (thumbs up/down per agent response), multi-model comparison view
(run one prompt across several models side by side), dedicated diff
reviewer (file-by-file, unified/split view, Markdown render/raw toggle),
declarative custom subagents (a project-level agents folder plus a config
file covering instructions, permissions, and custom agent definitions —
not just in-chat authoring).

### Tier 3 — Differentiated, not urgent
Multilingual (Ewe, Twi) + voice input, built-in design canvas, browser
automation, skills with interactive UI, in-IDE skill/agent authoring,
parallel agents on git worktrees, Kanban multi-agent panel (running
several agents side by side with a shared diff reviewer), cost/usage
dashboard, explainability/replay log, load/accessibility testing, live
pair programming, stacked PRs, notebook support, extension SDK + public
API, data residency controls, offline license activation, GDPR/local
compliance tooling, changelog automation, dependency update bot, low-spec
hardware mode, i18n/l10n tooling, visual CI/CD builder, message-broker
visualization, env-var management with drift detection, visual regression
testing, session recording/time-travel debugging, browser extension + CLI
companions, carbon/compute footprint indicator, bootcamp/university
learning mode, versioned/pinned team skill packs, settings backup/multi-
device sync, offline installer, in-app support chat, air-gapped enterprise
install, **JetBrains plugin** (moved up from Tier 4 — reviewers
specifically flag full JetBrains support, not just VS Code, as something
most competitors skip because the plugin SDK is harder; worth treating as
a real market gap rather than an afterthought — full sequencing in
`MULTI_PLATFORM_PLAN.md`).

### Tier 4 — Long-term / ecosystem
Third-party skill marketplace, mobile app, model gateway at zero markup
(500+ models — validated by competitor reviews as a genuine differentiator
against Cursor's per-request markup, not just a nice-to-have), dedicated
security branding, African payment-rail billing (Paystack/mobile money) +
usage-based billing, template/starter-project marketplace.

## Harness.io integration

Harness is a software delivery platform (CI/CD, feature flags, security
testing orchestration, cloud cost management, chaos engineering,
software supply chain assurance) that several roadmap items above
already overlap with. Rather than building each of those from scratch,
integrate with Harness's actual modules where they cover the same
ground — this is an **integrations-layer** addition (same category as
Slack/Teams/Jira), not a new architecture layer.

| Kete Workbench roadmap item | Harness module it maps to | Approach |
|---|---|---|
| In-IDE CI/CD status | Pipeline Execution API | Pull pipeline/build status directly rather than building a separate status poller |
| Infrastructure-as-code generation + cost estimation | Cloud Cost Management (cost recommendations, anomaly detection) + Infrastructure as Code Management module | Pull real cost data instead of estimating blind |
| **New**: SBOM generation | Software Supply Chain Assurance (SBOM generation/ingestion, drift detection, SLSA provenance, OSS governance policies) | Use SSCA instead of building SBOM tooling in-house — meaningfully more complete than a from-scratch implementation |
| Security subagent | Security Testing Orchestration (STO) — orchestrates existing scanners (Snyk, Checkmarx, etc.) under unified policy | STO doesn't replace the security subagent's diff-scoped review, but can feed it findings from an org's existing scanning stack rather than the subagent needing its own scanner integrations |
| Environment/infra subagent | Continuous Delivery module (supports Kubernetes/OpenShift deploy targets) | For orgs already on Harness CD, route deploys through it rather than raw `kubectl` — same governance-gate approval requirement applies either way |
| **New**: feature flag management | Feature Flags / Feature Management & Experimentation module | Not previously on the roadmap — create/toggle flags tied to a code change directly from the agent, useful enough to add explicitly |
| **New**: hook-compatible security analysis | Harness "Secure AI Coding" (beta) — already ships hook-based local analysis for Cursor, Windsurf, Claude Code | Kete Workbench's own hook taxonomy (`PreToolUse`, `PostToolUse`, etc.) should support acting as a target for this directly — low-effort, high-credibility integration since it's Harness's own outward-facing integration point, not something to reverse-engineer |

**Not pursuing for now**: Chaos Engineering and the Internal Developer
Portal module — real capabilities, but no clear roadmap tie-in yet; revisit
if a specific use case surfaces rather than integrating speculatively.

**Worth noting on scope**: Harness prices per-module, and their own
guidance warns against buying the full platform bundle reflexively —
worth keeping Kete Workbench's integration similarly modular (an org
enables the specific Harness modules it already pays for, not an
all-or-nothing connector) rather than assuming every customer has every
module active.

## Platform surfaces beyond the fork

The standalone forked IDE is the flagship experience, not the only one.
A lightweight VS Code extension, a JetBrains plugin, a CLI agent, a
mobile app, and a hosted cloud runtime are all planned as thin clients
over the same agent core (orchestrator, governance gate, tool layer,
skills/hooks, subagents) — see `MULTI_PLATFORM_PLAN.md` for the full
plan, build order, and the shared-core architectural rule that governs
all of them. This reorganizes several roadmap items above (CLI
companions, JetBrains plugin, mobile app, background/cloud agents) into
one coherent expansion strategy rather than leaving them as unrelated
backlog entries.

## Design lesson: no dedicated "Orchestrator" mode

Kilo Code shipped and then deprecated a dedicated Orchestrator mode,
citing real cost overhead — their own numbers: a task costing $0.50
direct could cost $1.50+ through the orchestrator. Their fix: let
Plan/Code/Debug modes delegate to subagents automatically and only when
it's actually useful, rather than routing every task through a mandatory
heavyweight orchestration layer.

Kete Workbench's governance gate remains the single chokepoint
everything passes through (that's a compliance requirement, not
optional) — but subagent delegation itself should be a lightweight,
inline decision the active mode makes per-task, not a separate mode a
user has to opt into or that every request pays the overhead of. Don't
build an "Orchestrator" mode as a peer to Plan/Code/Debug/Ask; build
delegation as a capability those modes call on when warranted.

**A terminology trap worth naming explicitly, since this doc uses
"orchestrator" for something else too**: "agent orchestrator" (the
always-on plan → act → observe engine in the system diagram above) and
the deprecated "Orchestrator mode" concept are NOT the same thing,
despite sharing a word. The orchestrator engine always runs, for every
mode, on every task — it's the runtime, not a persona a user selects.
Modes (Plan/Code/Debug/Ask) constrain what the orchestrator is allowed
to do; subagent delegation is a capability the orchestrator invokes
inline when useful. None of that is "an Orchestrator" in the sense Kilo
deprecated. If this ever reads ambiguously in code comments or UI copy,
prefer "agent core" or "agent loop" over "orchestrator" to avoid
implying a selectable Orchestrator mode exists.

## Why VS Code directly, not Cursor/Void

Forking `microsoft/vscode` directly (rather than an existing fork like
Cursor or Void) keeps upstream merges tractable. Cursor and Void have
patched core internals in ways that make tracking upstream painful — worth
the extra initial setup work to avoid inheriting that problem.
