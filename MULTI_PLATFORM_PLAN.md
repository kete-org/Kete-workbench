# Kete Workbench — Multi-Platform Expansion Plan

## Why this matters before it's built

The standalone forked IDE (the core product) has a real adoption cost:
it asks a developer to migrate their entire editor setup — extensions,
keybindings, muscle memory — to try the agent. Kilo Code and Qoder both
built their user base primarily through **lightweight extensions into
editors people already use**, not through a fork. Kilo Code specifically
frames this as "sessions that follow you from IDE to terminal to phone."

The fork remains the flagship, most integrated experience — but it
should not be the only door in. This plan adds four additional surfaces,
all thin clients over the same core.

---

## The one architectural rule this plan depends on

**Every surface below talks to the same agent core** — orchestrator,
governance gate, tool layer, skills/hooks, subagents, model routing.
None of them re-implement agent logic locally. A platform-specific
client is responsible for: rendering UI appropriate to that surface,
translating that surface's native actions (a JetBrains inspection, a
terminal command, a push notification) into the core's tool-call
interface, and nothing else.

Concretely: the core agent runtime should be extractable as a
standalone service (local process or remote endpoint, depending on
surface) that any client — the VS Code fork, a lightweight VS Code
extension, a JetBrains plugin, a CLI binary, a mobile app, or a cloud
worker — calls into. If a feature only exists in one client's codebase,
that's a sign the boundary was drawn wrong. This is the same lesson
Kilo Code's own "rebuilt on a portable, open-source core shared across
VS Code, the CLI, and Cloud Agents" migration encodes — worth taking
directly rather than relearning it after the fact.

---

## Platform-by-platform plan

### 1. VS Code Extension (lightweight, non-forked)
**What it is**: the same agent — orchestrator, subagents, skills,
governance gate — packaged as a standard installable extension for
*stock* VS Code, not the Kete Workbench fork. Lower adoption friction:
try the agent without switching editors.
**Relationship to the fork**: in the fork, agent features and UI are
planned as a bundled extension (`kete-agent`, not yet written) on top of
the governance gate in `src/vs/platform/governance/` (D-003). The
standalone extension would reuse that extension's code, packaged for Open
VSX (and the VS Code Marketplace, where its terms allow) with fork-specific
assumptions such as branding and bundled build tooling stripped out.
**Governance caveat**: stock VS Code has no `src/vs/platform/governance/`.
A gate inside an extension is advisory, because extension code can reach
models and processes without passing through it — the reason D-003 put the
gate in the platform layer. Outside the fork, the extension must route
agent actions through the shared core running as a service (see the
architectural rule above) to keep governance non-bypassable (D-010).
**Priority**: high — cheapest of the four once the fork's agent extension
exists.

### 2. JetBrains Plugin (IntelliJ, PyCharm, WebStorm)
**What it is**: same agent core, JetBrains Plugin SDK client. Already
flagged in `ARCHITECTURE.md` Tier 3 as a genuine market gap — most
competitors skip it because the plugin SDK is harder than VS Code's.
**Effort note**: JetBrains' plugin architecture (Kotlin/Java, different
UI toolkit, different extension points) means this is a real second
client to build, not a repackaging — budget accordingly, it's not free
just because the VS Code extension exists.
**Priority**: medium-high — real differentiator, but sequence after the
VS Code extension since that validates the "core as a service" boundary
first, cheaply.

### 3. CLI Code Agent
**What it is**: terminal-native client — `kete <task>` from the command
line, scriptable, suitable for CI pipelines and for developers who
prefer terminal-first workflows. Direct equivalent to Claude Code,
Codex CLI, and Kilo's own CLI surface.
**Why it matters beyond individual use**: this is the piece that makes
the agent usable in CI/CD (Tier 2's visual pipeline builder and in-IDE
CI/CD status both get more valuable once there's a CLI that can *run*
in that pipeline, not just report on it) and in the environment/infra
subagent's automation use cases.
**Priority**: high — also the lowest-friction way to prove the "shared
core" boundary is real, since a CLI has the thinnest possible UI layer.

### 4. Mobile App
**What it is**: remote task monitoring and control — review a diff,
approve or reject a governance-gated action, check background-agent
status, from a phone. Not a mobile IDE; a remote control surface for
work already in flight, matching the existing roadmap item and Kilo's
own mobile-continuity framing.
**Dependency**: needs Background/Cloud Agents (Tier 2) and the
governance approval-gate UI to exist first — a mobile app with nothing
running remotely to monitor isn't useful yet.
**Priority**: lower until the cloud surface below exists — sequence
after it, not before.

### 5. Cloud (hosted agent runtime)
**What it is**: sandboxed, async task execution on Kete Workbench's own
infrastructure rather than the developer's machine — send a task, it
runs in an isolated cloud sandbox, returns a PR for review. Direct
equivalent to KiloClaw and Cursor/Windsurf's background agents, already
scoped as Tier 2 "Background/Cloud Agents."
**Why this unlocks the others**: the CLI, mobile app, and even a Slack
slash-command all become meaningfully more useful once there's
somewhere for a task to run that isn't "must be at your laptop." Treat
this as infrastructure the other surfaces depend on, not a peer feature
shipped in parallel.
**Priority**: high, but sequence it as a prerequisite for mobile rather
than racing it against the CLI/JetBrains work.

---

## Suggested build order

1. **VS Code Extension** (lightweight) — cheapest, validates the shared-
   core boundary, immediate reach into the existing VS Code user base.
   Test installation into Cursor, Windsurf, and (with the caveats above)
   Trae as part of this same step, not a separate later effort.
2. **CLI** — thin client, unlocks CI/automation use cases, further
   proves the core-as-a-service boundary
3. **Cloud runtime** — infrastructure investment; unlocks async/remote
   workflows for every other surface
4. **Mobile App** — now has something real to monitor and control
5. **JetBrains Plugin** — highest standalone effort; do once the core
   boundary has been proven stable across three other clients first, so
   JetBrains isn't the one that discovers a hidden platform-specific
   assumption in the agent core

---

## Installing into other VS Code-compatible hosts (Cursor, Windsurf, Trae)

Cursor, Windsurf, and Trae are all themselves VS Code forks that support
standard `.vsix`/Open VSX extensions. This means the lightweight VS Code
Extension from section 1 above is **very likely to install into all
three without a separate codebase** — this isn't a sixth platform to
build, it's a compatibility/distribution question for the extension
that's already planned.

**What actually needs doing here:**
- Verify installation and basic function in each host — extension APIs
  can diverge slightly between forks, and none of them guarantee full
  upstream VS Code API parity
- Confirm each host's marketplace/distribution policy allows a
  competing agent extension at all (see risk below)
- Decide packaging: same `.vsix` for all four hosts (VS Code, Cursor,
  Windsurf, Trae) is the default assumption until testing says otherwise

**Real risk, not just a technical footnote — Cursor and Windsurf**:
both ship their own competing agent as the core product. There's real
precedent industry-wide for AI-IDE vendors restricting or blocking rival
AI extensions from their marketplace/runtime (this has happened with
other competing Copilot-style tools). Confirm current extension policy
for each before investing build time — this could turn out to be a
distribution dead end regardless of technical compatibility.

**Real risk worth taking seriously — Trae specifically**: Trae is
developed by ByteDance. Independent security analyses (Unit 221B, and a
follow-up report from The Register in July 2026; link the primary sources
before citing this externally) reported Trae making
hundreds of network calls and transmitting file contents, user IDs, and
device identifiers to ByteDance servers — **persisting even after
telemetry was explicitly disabled in settings**. This is a direct
conflict with Kete Workbench's own positioning: governance-first,
telemetry-off-by-default, auditable. Shipping a Kete Workbench extension
into a host with reported covert data collection risks a
developer's code and credentials passing through Trae's own telemetry
channel regardless of what the Kete extension itself does — and
associates the Kete Workbench brand with that host by extension.

**Recommendation**: build and verify for Cursor and Windsurf (real
distribution reach, standard competitive risk only). Do not prioritize
Trae support without either (a) independent verification that the
telemetry issue has been resolved in the version being targeted, or (b)
a clear, explicit warning to any customer who chooses to install into
Trae anyway. This isn't a compatibility nice-to-have to skip quietly —
flag it as a deliberate decision, logged in `DECISIONS.md` (D-011), not an
oversight.

## What NOT to do

Don't let the VS Code fork's agent extension quietly become the "real"
implementation with the other four as permanently-behind ports. If a
feature ships in the fork first, the follow-up work to expose it through
the shared core (not just the fork's extension) is part of that
feature's definition of done — not a separate backlog item that never
gets prioritized.
