# Decisions

Decisions with lasting consequences, and the reasoning behind them. Newest
first. A decision recorded here should not be relitigated without new
information — add a superseding entry instead of editing an old one.

---

## D-022 — The delivery phases, and what "done" means for each

**Status:** accepted
**Date:** 2026-09-16

The work has been planned in phases in conversation for weeks without being
written down, while the roadmap in `Kete_Workbench_Master_Roadmap.md` speaks in
tiers. Tiers are the *feature* backlog (D-013); phases are the *delivery*
order. Both stay, and this entry fixes the phase numbering so the two stop
drifting.

- **Phase 0 — Foundation.** Fork rebranded (D-004), Open VSX (D-002),
  telemetry off, `main` protected with required checks (D-014), native
  packaging for macOS arm64/x64 and Windows x64, app icons generated (D-021).
  Document icons for all 28 file types carry Kete's badge rather than the VS
  Code logo, the PWA introduces itself as Kete Workbench, and `product.json`
  names no Microsoft endpoint: `voiceWsUrl` and the `vscode-cdn.net` webview
  template are gone, and `apply-product-json.ts` strips them if an upstream
  sync puts them back. **Done**, except: packages are unsigned (needs
  certificates), the empty-editor letterpress art is still upstream's (it is a
  generic editor sketch, not a logo, so it carries no trademark), and a web
  build would still reach `vscode-cdn.net` through a fallback in
  `environmentService.ts` — code rather than configuration, and part of
  shipping the web surface in Phase 6.
- **Phase 1 — Governance.** The gate, classifier and durable audit log at the
  two call sites D-003 names, with policy pinning (D-006, D-016). MCP tools no
  longer default to `localWrite`: a tool whose origin is an MCP server is
  classified `remoteInfra`, the same treatment `run_task` gets, because the
  protocol says nothing about what the tool does — `create_issue` and
  `delete_cluster` look alike from here, and a server can change its tools at
  any time. It therefore always reaches a person instead of passing silently
  at the default threshold; trusting a particular server is a per-tool rule
  (D-006), not a default. **Two gaps remain**, each needing its own design
  rather than a classifier tweak:
  - **Agent-host sessions bypass the gate.** A Claude or Copilot CLI session
    runs out of process and its tool calls never reach `invokeTool`, so
    gating them means gating at the agent-host protocol boundary.
  - **Indirect commands are not inspected.** `bash deploy.sh` and a notebook
    cell carry their effect in a file the gate never reads. Closing this needs
    the classifier to see file contents, which today it cannot: it is a pure
    function in `platform/common` with no file access.
- **Phase 2 — Model routing and cost.** Kete Auto over Ollama, Claude and any
  OpenAI-compatible endpoint (D-017, D-020). **First increment done.** The
  offline request queue is an interface only, a Kete Auto request still writes
  two audit records, and no cloud vendor has been exercised against its real
  API.
- **Phase 3 — Agent core and project context.** `@kete`, the plan → act →
  observe loop, and `.ide-config.json` rules (D-018). **First increment
  done.** Governance denials are still recognised by message text rather than
  a structured marker.
- **Phase 4 — Modes, skills, subagents.** Not started. D-007 and D-008 already
  settle which modes exist.
- **Phase 5 — Retrieval and context.** Not started: hybrid retrieval, code
  graph, persistent context caches.
- **Phase 6 — Other surfaces.** Not started: the lightweight VS Code
  extension, CLI, cloud runtime, mobile and JetBrains clients, each a thin
  client over the shared core (D-010, `MULTI_PLATFORM_PLAN.md`).

**Two defects this entry also closes,** both found by running the product
rather than by testing it:

- **The first chat request after a restart failed** with "Language model
  unavailable". The editor resolves the model for a request before the
  participant runs, and `kete-models` activated only when that resolution
  asked for a provider — too late, so the first request had no models to pick
  from and the second worked. The extension now activates on
  `onStartupFinished`, which is what upstream's own chat extension does.
- **The Ollama request timeout was hard-coded at 120 s**, which silently ruled
  out slow or shared servers: a CPU-only machine answered a bare prompt in
  ~10 s but needed ~175 s for an agent-sized prompt with the workbench's
  tools. It is now `kete.models.ollama.requestTimeout`.

**The timeout has a ceiling the setting cannot lift.** Node's `fetch` ends a
request at 300 s on its own, and raising that needs an undici dispatcher the
extension does not have. The setting is capped at 290 s so the failure stays
ours and legible instead of surfacing as "fetch failed". A server that needs
longer than that for an agent prompt is simply too slow for local agent work;
the answer there is a cloud tier, a smaller model, or faster hardware, not a
larger number. Supplying a dispatcher is the follow-up if that stops being
true.

---

## D-021 — The app icon is a woven mark, generated from one SVG

**Status:** accepted
**Date:** 2026-09-15

Every application icon is now Kete Workbench's own, replacing the upstream VS
Code artwork that shipped in `resources/`.

- **The mark.** Two gold warp strips crossing two green weft strips, with the
  over/under alternating at all four crossings, on a dark rounded square.
  "Kete" is a woven basket (D-004), so the mark is a weave rather than a
  letterform — it says what the name means without depending on the Latin
  alphabet, and it isn't a coloured glyph like most editor icons.
- **Two masters, not one.** `resources/kete-icon.svg` is the full weave;
  `resources/kete-icon-small.svg` reduces it to a single crossing for targets
  32 px and under, where four crossings have more edges than there are pixels
  and silt up into a textured square. Both must change together.
- **Generated, never hand-edited.** `node generate-icons.ts` writes all 22
  files: the `.icns`, the two `.ico`s, the Windows tiles, the 14 Inno Setup
  installer bitmaps, and the Linux and PWA PNGs. Per-platform hand editing is
  what makes icon sets drift, and a fork will re-cut these more than once.
- **Rasterized with Chromium from the repo's `node_modules`,** because no SVG
  rasterizer can be assumed present and Chromium renders the SVG the way the
  editor would. `.icns` assembly uses `iconutil` and the installer bitmaps use
  `sips`, so the script currently needs macOS. CI never runs it; it packages
  the committed files.
- **The `.ico` files are written directly** (PNG-compressed entries, which
  Windows has read since Vista) rather than pulling in an icon library for one
  60-line container format.
- **Verified** by unpacking what was written: the `.icns` carries all ten
  entries, both `.ico`s list the expected sizes and every entry really is a
  PNG, and all 14 bitmaps kept the exact dimensions Inno Setup expects.
- **Still upstream artwork:** the ~29 per-language file-type icons and the
  empty-editor letterpress watermarks. They carry the VS Code logo, so they
  remain both a branding and a trademark item to close.

**Closed since (D-022):** the same script now also generates the 28 document
icons, so the VS Code logo they badged is gone. The letterpress watermarks
stay upstream's: they are a generic editor sketch, not a logo.

---

## D-020 — Cloud models come from interchangeable vendors; OpenAI-compatible is the second one

**Status:** accepted
**Date:** 2026-09-15

`extensions/kete-models` now serves the two cloud tiers from more than one
vendor: Claude (D-017) and an OpenAI-compatible provider, which is how Kete
supports OpenAI's models, Codex included.

- **Chat Completions, not the Responses API.** Chat Completions is the format
  every OpenAI-compatible server speaks, so the same provider reaches OpenAI,
  Azure OpenAI, OpenRouter, vLLM and LM Studio. One setting,
  `kete.models.openai.endpoint`, moves Kete between them.
- **Model ids are settings, not constants.** `openai.midModel` and
  `openai.frontierModel` default to the GPT-5 family but are meant to be
  changed: OpenAI renames and retires models, and a self-hosted server serves
  entirely different ones. A wrong id surfaces as a `notFound` error naming
  the model rather than a silent fallback.
- **Vendors are interchangeable to the router.** The router still reasons in
  tiers only; the service picks which vendor fills each tier before routing.
  `kete.models.cloud.vendor` sets the preference, and the other vendor is used
  when the first has no key, no model for that tier, or is unreachable. Because
  the retry loop excludes a model that failed and then re-decides, a failed
  Claude request can fall back to OpenAI within the same request, and the tiers
  may come from different vendors at once.
- **Model ids are vendor-qualified** (`anthropic/claude-sonnet-5`,
  `openai/gpt-5-codex`, `ollama/llama3.2:latest`), because two vendors can
  serve the same model name — an OpenAI-compatible server and Ollama both
  serve `llama3.2`.
- **The same guarantees hold.** Keys live only in secret storage, one command
  per vendor. Cloud settings stay application- or machine-scoped, so a
  workspace can't redirect traffic or turn on spend. Every concrete call still
  goes back through `vscode.lm`, so the governance gate records it under the
  real model id (D-003, D-017).
- **Not the Codex CLI.** Supporting OpenAI's Codex CLI as an agent host is a
  separate, larger piece of work, and agent-host sessions bypass the
  governance gate today (D-016). That gap would have to close first, so it is
  deliberately out of scope here.
- **Verified:** 30 unit tests, including a recorded Chat Completions stream
  with a split tool call, and cross-vendor routing. The Ollama path was also
  run against a real server on a LAN address, which confirms
  `kete.models.ollama.endpoint` reaches a non-localhost Ollama. No cloud
  vendor has been exercised against its real API yet.

---

## D-019 — Copilot is not the default chat agent

**Status:** accepted
**Date:** 2026-09-15

`product.json` no longer has a `defaultChatAgent` block, so `@kete` (D-018) is
the only default chat participant and Copilot's setup, sign-in and entitlement
flows don't run.

- **Why remove the key rather than repoint it.** Upstream treats the key as
  "Copilot is configured": with it, the workbench signs in to GitHub, fetches
  Copilot entitlements and offers Copilot setup. Without it,
  `ChatEntitlementService` and `ChatSetupContribution` switch themselves off
  — an upstream path, not a new one. Pointing the key at Kete would have kept
  those GitHub flows running against Kete's ids.
- **Type made optional, reads guarded.** `IProductConfiguration.defaultChatAgent`
  is optional, so the compiler finds every read. Each unguarded read is
  patched with a `// Kete Workbench:` comment: extension management, the
  extensions workbench service, the chat widget, the chat status dashboard
  and entry, onboarding and the default account service.
- **Two reads would have broken startup.** `onboardingVariationA.ts` asserted
  the key at module load (and `workbench.common.main` imports it); the
  assertion now runs only when onboarding renders, and `startupPage.ts` doesn't
  show onboarding without the key. `DefaultAccountService` waited for a
  provider that is never set; without the key it initialises with no account,
  and GitHub-backed features fall back to the built-in `github` authentication
  provider, as upstream's out-of-sources defaults do.
- **Copilot status bar entry hidden.** It reports Copilot plans, quotas and
  inline suggestions and offers "Use AI Features"; it is hidden without the
  key.
- **Tests.** Upstream tests that exercise Copilot-only behaviour (upgrade
  redirect URLs, the status bar entry and inline suggestion settings, the chat
  extension's profile-switch enablement) are skipped when `product.json`
  names no default chat agent, using upstream's conditional-skip pattern.
- **`apply-product-json.ts`** removes `defaultChatAgent`, so an upstream sync
  can't bring it back.
- **Verified in a launched dev build** with a fresh, signed-out profile: no
  Copilot setup, sign-in or status prompts; a chat message is answered by
  Kete with Kete Auto selected; no new errors in the renderer or extension
  host logs. Packaged builds already exclude the Copilot extension (Phase
  0.2); a dev build still scans `extensions/copilot` from source.

---

## D-018 — The agent core is a bundled extension; project rules can't touch governance or raise spend

**Status:** accepted (first increment)
**Date:** 2026-09-15

`extensions/kete-agent` provides the Kete agent on top of the gated APIs, as
D-003 planned.

- **Portable core, thin adapter.** `src/core/` holds the agent loop, project
  rules, prompt composition, context budgeting and model selection with no
  `vscode` or Node imports (D-010). `src/vscode/` adapts them. ESLint enforces
  the boundary.
- **Acts only through gated APIs.** Models via `vscode.lm`, tools via
  `vscode.lm.invokeTool` with the request's `toolInvocationToken`, so every
  call passes the governance gate and its single chat confirmation. ESLint
  forbids `fetch`, sockets, `child_process`, `fs` and other Node modules in
  the extension's source. The only direct file access is reading
  `.ide-config.json` and attached files.
- **Loop.** Plan → act → observe, at most 12 rounds, stopping when the model
  answers without tool calls or on cancellation. A call refused by
  governance or the person is not retried. Refusals are recognised by the
  gate's message text; a structured marker from the gate would be sturdier.
- **Model selection.** Kete Auto (`kete`/`kete-auto`) first, then the
  request's model, then any available model.
- **Default participant.** `@kete` is also registered as the default chat
  participant through a proposed API available to built-in extensions.
  Copilot is no longer `defaultChatAgent` (D-019).
- **`.ide-config.json`** holds structured rules, coding standards and a model
  tier cap. It is read only in trusted workspaces, and only known keys are
  read: governance-like keys are reported and ignored, and governance
  settings are never read or written. Free-form instructions stay with
  upstream's `AGENTS.md` and `*.instructions.md` files.
- **Rules can only lower model spend.** Only `modelRouting.maxTier` reaches
  the router. `preferredTier` isn't forwarded, so a repository cannot push
  requests to more expensive models.
- **Prompt layers implemented:** core prompt, a read-only description of the
  governance threshold, project rules, and a mode prompt (always `code` until
  `kete.mode` exists). Skills and subagents are empty today. A
  token-budgeted context assembler caps history, attachments and tool
  results.
- **Deferred:** modes, skills, subagents, Tree-sitter chunking and persistent
  context caches, inline/terminal/notebook default participants, a web
  entry, and a run in a launched editor.

---

## D-017 — Model routing is a bundled extension; Kete Auto routes through the governed path

**Status:** accepted (first increment)
**Date:** 2026-09-15

`extensions/kete-models` provides local and cloud models and the tiered
router. The stable `vscode.lm.registerLanguageModelChatProvider` API is
enough, so no core change was needed.

- **Providers.**
  - Ollama (default `http://localhost:11434`).
  - The Anthropic Messages API: Claude Haiku 4.5 as mid tier; Claude Sonnet 5
    and Claude Opus 5 as frontier.
  - Prompt caching on tools, system prompt and conversation prefix.
  - The Claude API key lives only in secret storage ("Kete: Set Claude API
    Key"). The API address is fixed in code.
- **Connectivity** is tracked per service: online after any success, offline
  when unreachable, degraded on server errors or slowness. Only degraded or
  offline services are re-probed, with backoff from 15 s to 5 min.
- **Kete Auto** (`kete`/`kete-auto`) starts at local and escalates only on
  explicit criteria:
  - a mode hint (`plan` → frontier, `debug` → mid)
  - a `minTier` hint
  - estimated prompt size
  - tools or images the local model can't handle
  It tries the required tier, at most one tier above, then lower tiers. A
  model that fails before producing output is excluded and the request is
  re-routed (up to 3 attempts). Every decision's reasons go to the "Kete
  Models" output channel; prompts and keys are never logged.
- **Governed path.** Kete Auto calls no backend itself. Each attempt goes
  back through `vscode.lm`, so every concrete call passes `sendChatRequest`
  and is audited under its real model id. That means two audit records per
  request. A governance refusal is never retried on another model.
- **The user controls spend.** `kete.models.routing.maxTier`,
  `cloud.enabled` and the token thresholds are application-scoped, and the
  Ollama endpoint and model are machine-scoped, so a workspace cannot
  redirect traffic or enable cloud spend. Request hints can raise the tier
  only within those settings, and a request's `maxTier` hint can only lower
  the cap.
- **Offline request queue:** specified as an interface (global storage,
  sent through `vscode.lm` when back online, visible and discardable) but
  not built, because interactive chat can't wait. It will be built with its
  first non-interactive caller.
- **Deferred:** exercising it in a launched editor; live Claude model
  limits and prices; preferring to stay on one model to keep prompt
  caches; a connectivity status indicator; a cost ledger; policy-backed
  spend settings.

---

## D-016 — Governance hardening: policy, durable audit, stricter classification

**Status:** accepted
**Date:** 2026-09-15

Three changes close the follow-ups left after Phase 1 (D-003, D-006).

### Policy can pin governance on, never off
`kete.governance.approvalThreshold` and `kete.governance.enabled` are
policy-backed (`KeteGovernanceApprovalThreshold`, `KeteGovernanceEnabled`,
category "Chat"), so OS or file policy overrides user settings.
- A policy value of `false` for `enabled` is treated as `true`, and logged.
  An organisation that could disable approval for everyone would break the
  human sign-off rule.
- While either setting is pinned by policy, a user's `enabled: false` is
  ignored. Otherwise switching gating off would bypass the admin's threshold.
- Still allowed: a policy (or user) can set the threshold to `production`,
  letting remote-cluster actions through without approval. D-006's
  "remote always needs approval" is not enforced yet.

### The audit store is authoritative and tamper-evident
Every decision is appended as JSON Lines to
`<default profile globalStorage>/keteGovernanceAudit/<YYYY-MM-DD>.<writer>.jsonl`.
- **Location.** Global storage survives sessions and profile switches; the
  logs folder rotates.
- **Layout.** One file per UTC day per writer, so windows never interleave
  in one file.
- **Tamper evidence.** Each record carries the SHA-256 of the previous
  stored line; `verifyAuditChain` finds the first broken link.
- **Writes are awaited and serialized.** A failed durable write denies the
  action even if the Output-panel log succeeded.
- **Not yet covered.** Truncating the last lines or deleting a whole file
  isn't detectable from the file alone (that needs an anchor stored
  elsewhere). Nothing runs verification automatically, and there is no
  retention policy. On web, hashing needs a secure origin; elsewhere every
  approved action would be denied.

### Classification errs towards asking
- **Tools are judged by their real ids.** The classifier knows VS Code's and
  Copilot's actual tool ids, each tied to the one origin allowed to own it.
  A call's tier is the higher of the tool's tier and its command line's.
- **Terminal tools.** All versions of the command are judged: the model's,
  the tool's rewrite and the person's edit.
- **`create_and_run_task`** is judged by its task's command and args, and
  refuses a label that already exists, which would run a different task.
- **`run_task`** is `remoteInfra`, because the command of an existing task
  isn't visible to the gate. Cost: at the default threshold, every agent
  task run needs one un-skippable confirmation. Chosen over letting deploy
  tasks run unseen. Follow-up: pass the resolved task command through the
  tool's prepared data.
- **Command lines no longer hide commands** behind separators, quoting or
  wrappers (`bash -c`, `sudo -u`, `git -C`, `terraform -chdir`). Deploys,
  merges, publishing and remote databases are recognised. `gh` read commands
  now need approval, as `aws`/`gcloud` already did.

### Known gaps
- **Agent-host sessions** (e.g. Copilot CLI's own shell and write tools) are
  confirmed in chat but never reach `invokeTool`, so they bypass the gate.
  This is the largest remaining gap.
- **MCP tools** still default to `localWrite`, even for remote servers or
  destructive operations.
- **Indirect commands** aren't inspected: scripts, notebook cells, task
  `dependsOn`, text sent to a terminal that's already in `ssh`, and `curl`
  calls that change remote state.

---

## D-015 — Docs describe what exists; runbooks track the process they describe

**Status:** accepted
**Date:** 2026-09-14

`SETUP.md` went stale in two ways at once. It told readers to
`git apply product.json.diff`, although that file is documentation, not a
patch. And it presented forking `microsoft/vscode` into "your org" as a live
step after the repository had already been established at
`kete-org/Kete-workbench`, turning a one-time action into a permanent, wrong
instruction. In the same pass, planning docs described code as existing that
had not been written: a `kete-agent` extension, per-tool governance
permissions and a `kete.mode` setting. Neither kind of error was caught until
the docs were read against the repository.

Rule: whenever a workflow, repository setting or implementation changes,
check the docs that describe it. Anything not yet merged is described as
planned, not as present.

---

## D-014 — `main` is protected: branch and pull request, no direct pushes

**Status:** accepted
**Date:** 2026-09-14

A repository ruleset on `kete-org/Kete-workbench` blocks direct pushes, force
pushes and deletion of `main`, and requires a pull request whose
`build.yml` checks (lint/compile plus the macOS arm64, macOS x64 and Windows
x64 packages) pass. This is the workflow, not an obstacle: it applies the
"no autonomous production changes without human sign-off" rule to the
repository itself, and every proposed change gets the full CI matrix.

Required approvals are currently 0 because there is a single maintainer, who
cannot approve their own pull requests. Raise it once a second maintainer
joins.

---

## D-013 — The tiered roadmap is a backlog, not a v1 scope

**Status:** accepted
**Date:** 2026-09-14

The tiers in `ARCHITECTURE.md` deliberately collect the full feature set seen
while reviewing Claude Code, Cursor, Codex, Gemini CLI/Antigravity, Windsurf,
Kilo Code and Qoder. It is a multi-year backlog, not a build instruction:
Tier 0 plus Tier 1 alone was sized at roughly 2–4 engineers over several
months. The actual v1 scope has to be chosen explicitly from it, not inferred
from an item's presence.

---

## D-012 — Integrate with Harness.io rather than rebuild what it covers

**Status:** accepted
**Date:** 2026-09-14

Several planned features — CI/CD status, SBOM generation, IaC cost
estimation, security-scan orchestration — overlap with Harness modules
(Pipeline Execution API, Software Supply Chain Assurance, Cloud Cost
Management, Security Testing Orchestration). Integrate with those instead of
building equivalents; SSCA in particular is far more complete than a
from-scratch SBOM feature would be for a long time.

The integration is modular, one Harness module at a time, matching how
Harness prices, because not every customer has every module. Harness's
hook-based "Secure AI Coding" integration already targets Cursor, Windsurf
and Claude Code, so Kete Workbench's hook events should support being a
target for it directly.

---

## D-011 — Trae is not a default target for the extension

**Status:** accepted
**Date:** 2026-09-14

Trae (ByteDance) is a VS Code fork and would probably accept the same
lightweight extension as Cursor and Windsurf. It is not a default target:
independent security research (Unit 221B, with follow-up reporting by The
Register in July 2026) reported Trae sending file contents, user IDs and
device identifiers to ByteDance servers, continuing after telemetry was
disabled in settings. That conflicts directly with this product's
governance-first, telemetry-off positioning.

Support Trae only with either independent verification that the reported
behaviour is fixed in the targeted version, or an explicit warning to
customers before they install into it. Link the primary sources here before
this reasoning is used in anything customer-facing.

---

## D-010 — One agent core; every surface is a thin client

**Status:** accepted
**Date:** 2026-09-14

`MULTI_PLATFORM_PLAN.md` adds a lightweight VS Code extension, a JetBrains
plugin, a CLI agent, a mobile app and a cloud runtime beyond the forked IDE,
following Kilo Code's "sessions that follow you from IDE to terminal to
phone" and its move to one core shared across VS Code, its CLI and cloud
agents. The binding rule, also a hard rule in `CLAUDE.md`: agent logic
(orchestrator loop, governance gate, subagents) lives in one shared core, and
each client only renders UI and translates its surface's actions into the
core's interface.

How this fits D-003:

- In the fork, the core's governance gate is the platform service in
  `src/vs/platform/governance/`, reached from `invokeTool` and
  `sendChatRequest`. Agent features and UI are planned as a bundled
  extension (`kete-agent`, not yet written) that calls into that service. It
  must never carry a gate of its own.
- Surfaces outside the fork (stock VS Code, Cursor, Windsurf, JetBrains, the
  CLI) don't have that platform service. For them, a non-bypassable gate
  requires the core to run as a service the client calls; gating implemented
  inside those clients is advisory, for the reason D-003 rejected an
  extension-hosted gate.

---

## D-009 — Enterprise tier: match Kilo Code's and Qoder's features, not their pricing

**Status:** accepted
**Date:** 2026-09-14

`ENTERPRISE_OFFERING.md` builds the Enterprise tier from what Kilo Code and
Qoder ship at that tier: SSO/SCIM, model policy controls, audit logs, plugin
distribution, shared spend pools and priority support. That feature shape is
proven and worth matching. Their pricing is not: both charge a flat USD
per-seat add-on (Qoder listed $20/seat/month when reviewed) with no regional
adjustment, which would abandon the purchasing-power pricing central to this
product. Enterprise pricing follows the same local-currency,
purchasing-power-adjusted approach as the other tiers.

---

## D-008 — One "Plan" mode; no separate "Architect" mode

**Status:** accepted
**Date:** 2026-09-14

The project's docs listed either four modes (Plan/Code/Debug/Ask) or five
(adding Architect), and the roadmap wrote "Architect/Plan" as one entry. That
reproduced the confusion in Kilo Code's own documentation ("Architect (called
Plan in some docs)") before it settled on one name. Resolved the same way:
one mode, called Plan. The planned mode setting is `kete.mode` with values
`plan`, `code`, `debug` and `ask`; modes are not implemented yet.

This also keeps "agent orchestrator" (the always-on plan → act → observe
engine) distinct from an "Orchestrator mode" (see D-007), which this project
does not build.

---

## D-007 — No dedicated "Orchestrator" mode

**Status:** accepted
**Date:** 2026-09-14

Kilo Code shipped and later deprecated a dedicated Orchestrator mode because
of its cost overhead; by its own figures, a task costing $0.50 directly could
cost $1.50 or more through the orchestrator. Adopt its fix: Plan, Code, Debug
and Ask delegate to subagents automatically, and only when that helps,
instead of routing every task through a mandatory orchestration layer. The
governance gate remains the single chokepoint, which is a compliance
requirement; subagent delegation is a lightweight per-task decision, not a
mode.

---

## D-006 — Governance permissions move to per-tool rules

**Status:** accepted (design direction — not yet implemented)
**Date:** 2026-09-14

**Current implementation** (Phase 1, per D-003): the gate in
`src/vs/platform/governance/` classifies each action into a risk tier —
`read`, `localWrite`, `localInfra`, `remoteInfra`, `production` — and requires
human approval at or above a policy-backed threshold
(`kete.governance.approvalThreshold`). It fails closed, and an action whose
audit entry cannot be written is denied.

**Planned:** per-tool permissions (`read`, `edit`, `bash`, `kubectlApply`, …),
each independently `allow`, `ask` or `deny`, matching Kilo Code's redesign
after it found category-level control too coarse for real teams. Unknown
tools default to `ask`, never a silent approval.

What the rework must keep:

- A shared or remote target always requires approval, whatever a tool's
  permission says; this stays non-configurable.
- Fail-closed behaviour, and policy values overriding user and workspace
  settings.

---

## D-005 — Remote development over SSH, without Tailscale

**Status:** accepted
**Date:** 2026-09-14

Tailscale is deliberately excluded. Plain SSH remote development covers the
need without adding a mesh-networking dependency to the product.

Because the extension gallery is Open VSX (D-002), Microsoft's Remote-SSH
extension is not available. SSH remote development therefore needs an
open-source implementation such as `open-remote-ssh`, or our own; it is not
inherited ready-made.

---

## D-004 — The product name is "Kete Workbench"

**Status:** accepted — confirmed as the final name on 2026-09-14
**Date:** 2026-09-14
**Supersedes:** D-000

### Context

D-000 required settling the name before Phase 0.2 produced artifacts. That
point has arrived: CI now packages macOS arm64, macOS x64 and Windows x64
builds. The GitHub organisation and repository are `kete-org/Kete-workbench`.

Naming history:

1. **"Kente Studio"** — chosen for the weaving metaphor: multi-file
   composition, with patterns and skills as woven-in components. Dropped
   after it turned out to collide with an existing product name.
2. **"Baobab"** and the Ewe words *Adanudo* (woven cloth) and *Dzotsotsoe*
   (perseverance) were considered. Instead, the weaving concept was kept and
   "Studio" became **"Kente Workbench"**, which reduced the collision but did
   not remove it.
3. **"Milawei"**, then **"Milawei Workbench"**, were drafted to drop "Kente"
   entirely, but not adopted.
4. **"Kete Workbench"** — final. *Kete* is the Ewe name for the weaving
   tradition Akan speakers call Kente (from *ke*, "open", and *te*, "close",
   the motion of weaving). It keeps the metaphor, is rooted in Ewe heritage,
   and its spelling separates it from the earlier collision.

A formal trademark search (Ghana Registrar-General and target markets) is
still due before domain registration, trademark filing or public launch. That
is risk mitigation; the name itself is decided.

### Decision

The product's name is **Kete Workbench**, and every identifier that is
written to a user's machine derives from it:

| Key | Value |
|---|---|
| `nameShort`, `nameLong`, `win32DirName`, `win32NameVersion` | `Kete Workbench` |
| `applicationName`, `urlProtocol`, `linuxIconName` | `kete-workbench` |
| `dataFolderName`, `sharedDataFolderName` | `.kete-workbench`, `.kete-workbench-shared` |
| `serverApplicationName`, `serverDataFolderName`, `tunnelApplicationName` | `kete-workbench-server`, `.kete-workbench-server`, `kete-workbench-tunnel` |
| `darwinBundleIdentifier` | `dev.keteworkbench.desktop` |
| `win32AppUserModelId`, `win32RegValueName` | `KeteWorkbench.KeteWorkbench`, `KeteWorkbench` |
| `win32MutexName`, `win32TunnelMutex`, `win32TunnelServiceMutex` | `keteworkbench`, `keteworkbench-tunnel`, `keteworkbench-tunnelservice` |
| win32 AppIds, `darwinProfileUUID`, `darwinProfilePayloadUUID` | newly generated GUIDs |

The rebrand had left several of these at their Code - OSS values, including
the Windows AppIds, URL protocol, shared data folder and server/tunnel names.
On a machine that also has Code - OSS installed, identical AppIds make the
installers treat the two as the same application, and a shared URL protocol
and data folder make them compete for links and state. All of them now carry
this product's name. `licenseUrl` and `reportIssueUrl` point at this
repository instead of `microsoft/vscode`.

### Consequences

- Once installable builds are distributed, renaming again requires a
  profile-migration path, not a find-and-replace (the reason D-000 existed).
- `apply-product-json.ts` holds these exact values and re-applies them if an
  upstream sync overwrites `product.json`.
- Governance setting IDs use the `kete.` prefix (`kete.governance.enabled`,
  `kete.governance.approvalThreshold`).
- Files authored for this fork carry a "Kete Workbench contributors"
  copyright header; `build/hygiene.ts` and `eslint.config.js` accept it
  alongside Microsoft's.
- The git branch `kente/tier0-foundation` keeps its old spelling, since
  renaming it would close its open pull request.

---

## D-003 — Governance gate lives in `platform/`, agent features live above it

**Status:** accepted
**Date:** 2026-09-13
**Signed off:** 2026-09-13 — Phase 1 unblocked.

### Context

`ARCHITECTURE.md` described the agent orchestrator as "not yet started" and
placed the MCP client in Tier 2. Both are out of date. This fork is based on
VS Code 1.139, which already ships:

| Inherited | Location | Scale |
|---|---|---|
| Agent/chat UI and tool-calling loop | `contrib/chat` | 1,138 `.ts` files (770 non-test) |
| MCP client | `contrib/mcp` | 86 `.ts` files |
| Vendor-agnostic model registry | `ILanguageModelsService` | `registerLanguageModelProvider(vendor, provider)` |
| Policy-backed tool approval | `languageModelToolsConfirmationService`, `agentHostConfigPolicy` | — |
| Agent sessions workbench layer | `src/vs/sessions/` | — |

So the real question is not "how do we build an orchestrator" but "how do we
route the one we inherited through a Kete governance gate."

### Findings from the spike

**1. Two genuine chokepoints exist, and both are in the renderer, not the
extension host.**

- All tool execution funnels through
  `ILanguageModelToolsService.invokeTool` —
  `contrib/chat/browser/tools/languageModelToolsService.ts:489`. There are
  exactly three non-test callers, and the extension-facing one
  (`mainThreadLanguageModelTools.ts:64`) routes into the same service.
- All model calls funnel through `ILanguageModelsService.sendChatRequest` —
  `contrib/chat/common/languageModels.ts:1447`. The extension-facing path
  (`mainThreadLanguageModels.ts:230`) also routes into it.

Extension code reaches both only across the `mainThread*` RPC bridge, so a
check inside these two methods cannot be bypassed by extension code calling
the LM or tools APIs.

**2. Upstream already implements policy-over-project precedence.**

`configurationModels.ts:1034-1039` applies policy values *last*, overwriting
default, user, workspace, and folder configuration. A policy-backed setting
therefore cannot be overridden by a user or by a project file. This is
exactly the `ARCHITECTURE.md` requirement that governance policy sit above
`.ide-config.json`, already built and battle-tested — we should use it rather
than invent a parallel precedence system.

**3. Copilot coupling is real but mostly shallow.** 184 of 770 non-test files
in `contrib/chat` mention Copilot, concentrated in settings keys, error
strings, and CLI/agent-host glue rather than in the orchestration core.

### Options considered

**A. Fork core.** Build the gate and the agent directly into `contrib/chat`.
Best UX integration and fastest to something working, but it patches the
highest-churn area of upstream. This is the failure mode that `D-001` forked
directly to avoid.

**B. Bundled extension.** Ship the agent as an extension over the LM API,
tools API, and MCP. Near-zero merge cost — but **it cannot satisfy our hard
rule.** Extensions are peers, not a chokepoint: an extension can call a model
API over plain `fetch` and spawn processes directly, never touching
`sendChatRequest` or `invokeTool`. A gate implemented at this layer is
advisory, and an advisory governance gate is not a governance gate.

**C. Hybrid — chosen.** Gate service in `src/vs/platform/governance/`, new
code in a new directory, owned entirely by us. `contrib/chat` is lower-layer-
dependent on `platform/`, so the two chokepoints above call *into* the gate.
Agent features and UI ride on top as a bundled extension.

### Decision

Option **C**.

The upstream patch surface is two call sites — `invokeTool:489` and
`sendChatRequest:1447` — on the order of ten lines in two files, in methods
whose signatures are stable because the whole extension API depends on them.
Everything substantial lives in `platform/governance/`, which upstream will
never touch. That buys a non-bypassable chokepoint for roughly the merge cost
of option B.

### Consequences and limits

- **Scope of the gate is the Kete agent and anything using the LM/tools
  APIs — not arbitrary extension code.** A third-party extension can still
  open its own socket. Constraining that is an extension-permissions problem,
  a separate and much larger piece of work. We must not describe the gate as
  sandboxing arbitrary extensions; it does not.
- Every upstream merge must re-verify those two call sites still exist. This
  belongs in the merge runbook in `SETUP.md`, and ideally as a test that
  fails loudly if a gated path stops being gated.
- The audit log must record model calls, not only tool calls — `sendChatRequest`
  is a chokepoint precisely so that cost and prompt content are auditable.
- Re-tier: MCP client moves from Tier 2 to inherited. "Agent orchestrator
  scaffold" moves from build to adopt. Diff/edit UI and checkpointing are
  inherited and only survive under options A/C; under B they would have been
  rebuilt.

---

## D-002 — Extension gallery is Open VSX

**Status:** accepted
**Date:** 2026-09-13

Microsoft's marketplace terms do not permit use by third-party forks, so
`product.json` points `extensionsGallery` at `https://open-vsx.org`.

Consequence: extensions published only to Microsoft's marketplace are
unavailable, including Microsoft's Remote-SSH. The Tier 0 "SSH remote dev"
item therefore needs an open-source substitute (`open-remote-ssh`) or our
own implementation — it is not a matter of installing the usual extension.

Upstream's `build/hygiene.ts` rejected any `product.json` containing
`extensionsGallery`, which is correct for Code - OSS (Microsoft injects its
gallery at build time) but blocks a fork that must ship its own. The check is
inverted in this fork to forbid Microsoft's marketplace instead, so it now
enforces our endpoint rule rather than fighting it.

---

## D-001 — Fork `microsoft/vscode` directly, not Cursor or Void

**Status:** accepted

Forking upstream directly keeps merges tractable. Cursor and Void have
patched core internals in ways that make tracking upstream painful; the extra
initial setup work is worth avoiding that inheritance.

This decision is the reason several other rules exist: `product.json` is kept
byte-identical to upstream's `JSON.stringify(obj, null, '\t')` formatting so
its diff stays at ~27 lines instead of ~497, and D-003 chose its architecture
primarily on merge surface.

---

## D-000 — The name "Kente Workbench" is provisional

**Status:** superseded by D-004

Changed from "Kente Studio". Still not final.

`dataFolderName`, `darwinBundleIdentifier`, `urlProtocol`, and the win32
AppId GUIDs are written into user machines the moment an installable build
ships. Renaming after that point means a profile-migration path, not a
find-and-replace. Settle the name before Phase 0.2 produces artifacts.
