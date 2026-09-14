# Kete Workbench — Master Product Roadmap

**A VS Code–fork IDE with an embedded, governance-aware coding agent, built for African developer economics.**

*A one-document summary. Where it differs from `ARCHITECTURE.md` or `DECISIONS.md`, those are authoritative.*

---

## 1. Product Identity

- **Name:** Kete Workbench — **final, decision closed** *(previously "Kente Studio", then "Kente Workbench", then "Milawei", then "Milawei Workbench")*. "Kete" is the Ewe-language name for the same weaving tradition Akan speakers call "Kente" — it keeps the weaving metaphor while its spelling separates it from the earlier name's collision with an existing product. A trademark search is still due before public launch — see §10 — but that's risk mitigation, not naming uncertainty. Full history in `DECISIONS.md` (D-004).
- **Origin:** Started as an internal tool for the product owner's team; now also being explored as an independent commercial product.
- **Positioning:** Not "Cursor but African" — an IDE whose entire cost structure is engineered for African developer economics. The average developer in sub-Saharan Africa cannot afford tools like Cursor or Lovable at Western price points; this is the core wedge, not a branding afterthought.
- **Platforms:** macOS and Windows (native builds via CI matrix, not cross-compiled).

---

## 2. Tier 0 — Foundation

Must exist before anything else works.

| Component | Notes |
|---|---|
| VS Code fork | Fork `microsoft/vscode` directly (not Cursor/Void) to keep upstream merges clean |
| Agent orchestrator | Multi-turn tool-calling loop: plan → act → observe → self-correct. Adopt the loop inherited from upstream VS Code rather than building one (D-003) |
| Tool layer | `read_file`, `edit_file`, `run_terminal`, `search_code`, git ops — sandboxed, permission-gated |
| Diff/edit UI | Propose changes as diffs; accept/reject/edit before applying (inherited from upstream) |
| Checkpointing / snapshots | Revertible state before each agent action (inherited from upstream) |
| macOS + Windows CI matrix | GitHub Actions (`macos-latest` arm64, `macos-15-intel` x64, `windows-latest` x64) — native builds, no cross-compilation. Done: packages build on every PR |
| Code signing | Apple Developer account (notarization mandatory) + Windows cert (can defer EV cert) |
| Project rules file | `.ide-config.json` — model routing thresholds, coding standards, rules |
| Governance approval gates + audit log | Hard rule: no autonomous production changes without human sign-off (inherited from established enterprise AI governance practice). Gate, risk classifier and audit log are wired into every tool call and model request, with an approval dialog (D-003). Still to come: admin policy pinning and a persistent audit store |
| Dual-mode online/offline model routing | `ModelProvider` interface (`OllamaProvider`, `ClaudeAPIProvider`), connectivity state machine (online/offline/degraded) |
| Tiered model routing + self-hosted inference | Small local model for routine work, mid/frontier tier only when needed; cuts inference cost, the core economic lever |
| Context efficiency | AST-aware chunking (Tree-sitter), persistent context cache, diff-only context updates |
| Offline request queue | Disk-persisted queue for frontier-tier requests made while offline |
| Remote dev | Plain SSH remote development (Tailscale deliberately excluded). Microsoft's Remote-SSH isn't on Open VSX, so this needs an open-source implementation (D-005) |

---

## 3. Tier 1 — Core Differentiators

Highest leverage; sequence immediately after Tier 0.

- **Skills loader** — standard `SKILL.md` format (open standard, compatible with the wider ecosystem) + curated starter pack (security, debugging, UI/UX skills)
- **Hybrid retrieval indexing** — vector search + code graph + pre-indexed knowledge base (stronger than vector-only RAG)
- **Hooks** with concrete event taxonomy: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`
- **Security subagent** — diff-scoped static analysis (Semgrep-style) + model review for ambiguous cases; blocking vs. advisory findings
- **Regression testing subagent** — test-impact analysis via dependency graph, plain-language failure summaries
- **Plan mode + named modes** (Plan, Code, Debug, Ask — no separate "Architect" mode; merged in, since it described the same thing under a different name) — user-selectable constraint on what the agent may do
- **Slack + Microsoft Teams integration** — approval routing, notifications, slash commands, threaded PR discussion, status digests; writes to the same audit log as in-IDE approvals
- **Environment/Infra subagent** — provision and interact with Docker containers and Kubernetes pods (Supabase, Redis, Postgres, etc.) via natural language; local Docker Compose = low friction, remote cluster changes = full approval gate
- **Secrets vault** — encrypted local/team secret storage; agent never sees or commits plaintext
- **Per-tool governance permissions** — `read`/`edit`/`bash`/`kubectlApply`/etc. each independently allow/ask/deny, not broad categories; unknown tools default to `ask`. A planned rework of today's risk-tier model, following Kilo Code's own redesign — see D-006.
- **Context/token usage timeline** — visible session-activity bar (color-coded by read/write/tool/error/text) plus a token budget bar (used/reserved/available) that warns past 50% used
- **Snapshot/revert UX** — git-based snapshots before/after every agent edit; revert any message's changes directly from chat, with a banner shown when viewing an earlier state
- **`/review` as a flexible command** — no-argument reviews staged/unstaged/untracked changes; scoped variants for a specific branch, commit hash, or PR reference — not a single "run review" action

---

## 4. Tier 2 — Strong Second Wave

- Composio-style connector gateway (1,000+ app integrations) — the MCP client itself is inherited from upstream (D-003)
- Repo Wiki — auto-generated, persistent architecture documentation
- Prompt-to-UI subagent + Figma integration (import, design-to-code, token sync) + design tokens
- Background/Cloud Agents — sandboxed, async, long-running tasks that return a PR
- Persistent cross-session memory (coding conventions, architectural decisions)
- Documentation, code-review, API-contract, and dependency/license subagents
- Automated commit messages + PR descriptions from the agent's own reasoning trace
- In-IDE CI/CD status (no browser tab switching — Harness Pipeline Execution API where available, see Harness integration section below)
- Enterprise controls: SSO, SCIM, group-based permissions, model policy controls, private model gateway, shared spend pool, plugin/skill distribution management, private capability marketplace — full spec in `ENTERPRISE_OFFERING.md`
- Data & API tooling: DB schema visualizer (ERD), API test/mock panel, seed/fixture data generation
- Observability panel: metrics (Grafana/Prometheus-style) + aggregated log view, in-IDE
- Infrastructure-as-code generation (Terraform-style diffs) + cost estimation before applying (Harness Cloud Cost Management integration where available)
- **Feature flag management** — create/toggle flags tied to a code change directly from the agent (Harness Feature Flags / FME module)
- WhatsApp + SMS-fallback notifications — matches actual communication habits in target market better than Slack/Teams alone
- Org-wide code search across every repo a team has access to
- Jira / Linear / Confluence sync
- Admin/telemetry dashboard — usage, cost, adoption metrics per team
- **Enhance Prompt** — rewrites a rough user prompt into a clearer one before sending
- **Session Goals** — explicit, tracked objectives for a session, distinct from the running conversation
- **Message-level feedback** — thumbs up/down per agent response, a lightweight product-improvement signal
- **Multi-model comparison view** — run one prompt across several models side by side (manual comparison, distinct from automatic tiered routing)
- **Dedicated diff reviewer** — file-by-file, unified/split view, Markdown render/raw toggle
- **Declarative custom subagents** — a project-level agents folder plus a config file covering instructions, permissions, and custom agent definitions, not just in-chat authoring

---

## 5. Tier 3 — Differentiated, Not Urgent

- Multilingual agent interaction (Ewe, Twi, etc.) + voice input
- Built-in lightweight design canvas (component-bound, not a full Figma competitor)
- Browser automation for the agent (navigate/read live pages, not just search)
- Skills that render interactive UI (forms/charts/config panels in chat)
- `create-skill` / `create-agent` authored conversationally from inside the IDE
- Parallel agents on isolated git worktrees (best-of-n)
- Kanban-style multi-agent management panel — running several agents side by side with a shared diff reviewer
- Cost/usage dashboard (per-developer) + explainability/replay log for agent decisions
- Load/performance testing, accessibility (WCAG) testing
- Live pair-programming/session sharing; stacked PR support for large agent changes
- Jupyter/notebook integration (data, ML and NLP work)
- Extension/plugin SDK + public API for the agent orchestrator
- Data residency controls, GDPR/local data-protection compliance tooling (Ghana Data Protection Act and equivalents)
- Offline license activation
- Automated changelog/release notes generation
- Dependency update bot (Renovate-style), routed through the approval gate
- **Low-spec hardware mode** — genuine differentiator; competitors have no incentive to optimize for older/lower-RAM machines
- i18n/l10n string extraction and translation management, including Ghanaian languages
- Visual CI/CD pipeline builder
- Message-broker visualization (Kafka/RabbitMQ)
- Environment variable management UI with drift detection across dev/staging/prod
- Visual regression (screenshot-diff) testing
- Session recording / time-travel debugging
- Browser extension + CLI companion tools
- Carbon/compute footprint indicator (pairs with data-cost-aware UX)
- Bootcamp/university "learning mode" (verbose reasoning, teachable moments)
- Versioned, pinned team skill packs (no silent behavior drift)
- Settings/session backup + multi-device sync
- Offline installer / low-bandwidth differential updates
- In-app support/help chat
- Air-gapped enterprise install option (banks, government, ministries of education, and similarly regulated institutional clients)
- **JetBrains plugin** — moved up from Tier 4: competitor reviews specifically flag full JetBrains support (not just VS Code) as something most agent products skip because the plugin SDK is harder — a real market gap, not an afterthought

---

## 6. Tier 4 — Long-Term / Ecosystem

- Third-party skill marketplace (vendor-contributed, governance-reviewed)
- Mobile app for remote task monitoring/control
- Model gateway at zero markup (500+ models, pass-through provider pricing — OmniRoute-style; validated by competitor reviews as a genuine differentiator against per-request markup pricing, not just a nice-to-have)
- Dedicated security product branding (own audit/compliance story, like Codex Security / Qoder Security)
- African payment-rail billing (Paystack/mobile money) + usage-based billing engine
- Template/starter-project marketplace (SaaS, fintech, telecom-integration starters)

---

## 7. Platform Surfaces Beyond the Fork

The standalone forked IDE is the flagship experience, not the only one.
A lightweight VS Code extension (installs into stock VS Code, and very
likely into Cursor and Windsurf without a separate build, since all
three are VS Code-compatible), a JetBrains plugin, a CLI agent, a mobile
app, and a hosted cloud runtime are planned as thin clients over the
same agent core — full plan, build order (VS Code ext → CLI → Cloud →
Mobile → JetBrains), and the binding "shared core, not five
reimplementations" rule in `MULTI_PLATFORM_PLAN.md`.

Trae (ByteDance) is technically compatible the same way, but is
deliberately **not** a default target — independent security research
documented persistent telemetry to ByteDance servers even after
disabling it in settings, which conflicts directly with this product's
governance-first positioning. See `MULTI_PLATFORM_PLAN.md` and
`DECISIONS.md` for the full reasoning.

---

## 8. Harness.io Integration

Several items above overlap with Harness's own product modules —
integrate rather than rebuild:

| Roadmap item | Harness module | Approach |
|---|---|---|
| In-IDE CI/CD status | Pipeline Execution API | Pull real pipeline/build status |
| IaC cost estimation | Cloud Cost Management | Pull real cost data instead of estimating |
| SBOM generation | Software Supply Chain Assurance (SSCA) | Meaningfully more complete than a from-scratch build |
| Security subagent | Security Testing Orchestration (STO) | Feed findings from an org's existing scanner stack |
| Environment/infra subagent | Continuous Delivery module | Route deploys through Harness CD where an org already uses it, same governance-gate approval either way |
| Feature flag management (new) | Feature Flags / FME module | — |
| Hook-compatible security analysis (new) | Harness's own "Secure AI Coding" hooks (already supports Cursor, Windsurf, Claude Code) | Kete Workbench's hook taxonomy should support being a target directly — low effort, high credibility |

Kept modular — an org enables the specific Harness modules it already
pays for, not an all-or-nothing connector, matching how Harness itself
prices. Full detail in `ARCHITECTURE.md`'s Harness.io integration section.

---

## 9. Design lesson: no dedicated "Orchestrator" mode

Kilo Code shipped and later deprecated a dedicated Orchestrator mode
after finding it added real cost overhead — their own figures: a task
costing $0.50 direct could run $1.50+ through the orchestrator. Their
fix: Code/Plan/Debug modes delegate to subagents automatically and only
when useful, rather than routing every task through a mandatory
orchestration layer.

Kete Workbench keeps the governance gate as the single chokepoint
everything passes through — that's a compliance requirement, not
optional — but subagent delegation itself should be a lightweight,
inline decision the active mode makes per task, not a separate mode a
user opts into or that every request pays overhead for.

---

## 10. Known Risks & Open Decisions

| Risk | Detail |
|---|---|
| **Name collision (resolved) — trademark search open** | Product name is finalized as "Kete Workbench" (previously "Kente Studio", then "Kente Workbench", then "Milawei", then "Milawei Workbench"). "Kete" is the Ewe-language name for the same weaving tradition, and its different spelling separates it from the earlier name's collision with an existing product. The naming decision itself is closed; remaining steps are risk mitigation, not reconsideration: formal trademark search (Ghana Registrar-General + target markets), then register the domain and trademark early. |
| **Resourcing reality** | Tier 0 + Tier 1 alone ≈ 2–4 engineers over several months. Full backlog (Tiers 0–4) realistically represents 1–2+ years with a growing team. This roadmap is comprehensive by design — not a v1 scope. |
| **Competitive landscape** | Cursor, Windsurf, Replit, Qoder, Kilo Code are all well-funded or backed by major platforms (Anysphere, OpenAI/Windsurf, Alibaba). Direct feature-parity competition is not winnable for a small team; the affordability/cost-structure wedge is the actual defensible position, not raw capability matching. |
| **Governance line to hold** | "No autonomous AI production changes without human sign-off" must be enforced structurally (approval gates + audit log), not just as a policy statement — this applies equally to code changes, infra provisioning on shared clusters, and skill installation. |
| **Model-cost economics** | Margin on AI inference is the single biggest threat to unit economics given the affordability positioning. Tiered routing + self-hosted local inference is not optional polish — it is the business model. |

---

## 11. Suggested Immediate Next Step

Lock down:
1. Actual team size and timeline available
2. Which Tier 1 items ship in a real v1 (not all of Tier 1 needs to ship simultaneously)
3. A trademark search on "Kete Workbench" before domain registration or public-facing branding work — the name itself is decided, this is risk mitigation

Once those three are answered, this document can be turned into a phased delivery plan with milestones, rather than a backlog.
