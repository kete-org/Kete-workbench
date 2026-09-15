# Kete Workbench

[![Build](https://github.com/kete-org/Kete-workbench/actions/workflows/build.yml/badge.svg)](https://github.com/kete-org/Kete-workbench/actions/workflows/build.yml)

A code editor with an embedded, governance-aware coding agent, built for
African developer economics: cost-tiered model routing, offline-first
operation, and support for low-spec hardware.

Kete Workbench is a fork of [`microsoft/vscode`](https://github.com/microsoft/vscode)
("Code - OSS"). It is an independent project and is not affiliated with or
endorsed by Microsoft.

> **"Kete Workbench" is the final product name.** See
> [D-004 in DECISIONS.md](DECISIONS.md#d-004--the-product-name-is-kete-workbench).

## Status

Early development — **there is no installable release yet.** The project is in
Tier 0 (foundation).

| Area | State |
|---|---|
| Editor shell rebrand (`product.json`) | Done |
| Extension gallery → Open VSX | Done |
| Telemetry off by default | Done |
| Native packaging CI (macOS arm64/x64, Windows x64) | Passing; produces unsigned packages as CI artifacts |
| Governance gate, risk classifier, audit log | Wired into every tool call and model request; settings pinnable by admin policy; durable, hash-chained audit log; tests run in CI. Agent-host sessions and MCP tools are not yet fully covered |
| Model routing (`kete-models`) | First increment: local Ollama, Claude and OpenAI-compatible providers, and **Kete Auto**, which picks the cheapest capable tier and falls back offline. Unit-tested, and checked against a real Ollama server; no cloud vendor exercised end to end yet. Offline request queue is specified but not built |
| Agent (`kete-agent`) and project rules | First increment: `@kete` default chat participant with a plan → act → observe loop, `.ide-config.json` project rules, layered prompts. Unit-tested; not yet exercised in a launched editor. Modes, skills and subagents are still to come |
| Product icons | App icons generated from `resources/kete-icon.svg` for macOS, Windows (including installer bitmaps), Linux and the PWA. File-type icons and the empty-editor watermark are still upstream artwork |

## How it differs from Code - OSS

- **Extensions come from [Open VSX](https://open-vsx.org).** Microsoft's
  marketplace terms don't permit use by forks, so extensions published only
  there — including Microsoft's Remote-SSH — are unavailable.
- **Telemetry is off by default** (`enableTelemetry: false`). Any future
  collection requires a documented opt-in.
- **The built-in GitHub Copilot extension is not packaged.** It reaches models
  directly rather than through the governance gate.
- **Agent actions pass through one governance gate.** Every tool call and
  model request goes through a single chokepoint. Actions at or above the
  approval threshold (remote or shared infrastructure, by default) need your
  approval before they run: you're asked once, in the tool's own chat
  confirmation, which auto-approval settings can't skip. Every decision is
  written to a durable, append-only, hash-chained audit log, and an action
  whose decision can't be written is denied. The threshold is an application
  setting that an organisation can also pin by policy, so a repository's
  workspace settings cannot lower the bar for its own code.

## Architecture

```
IDE shell → agent orchestrator → governance gate → capability layer → integrations
                                  (approval + audit)  (model routing, retrieval,
                                                       tools & infra, skills & hooks)
```

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design and the tiered feature roadmap
- [DECISIONS.md](DECISIONS.md) — decisions and their rationale, including why the
  gate lives in `src/vs/platform/` rather than in an extension (D-003)
- [Kete_Workbench_Master_Roadmap.md](Kete_Workbench_Master_Roadmap.md) — the
  product roadmap in one document
- [MULTI_PLATFORM_PLAN.md](MULTI_PLATFORM_PLAN.md) — VS Code extension, JetBrains,
  CLI, mobile and cloud surfaces over one shared agent core
- [ENTERPRISE_OFFERING.md](ENTERPRISE_OFFERING.md) — the Enterprise-tier feature spec
- [SETUP.md](SETUP.md) — contributor setup runbook

## Building from source

### Prerequisites

- **Node.js** — the exact version in [`.nvmrc`](.nvmrc). A mismatch fails
  `npm ci` on purpose; run `nvm use` first.
- **Python 3** and a C/C++ toolchain for native modules:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio 2022 with the *Desktop development with C++* workload
  - Linux: `build-essential`, `libkrb5-dev`, `libx11-dev`, `libxkbfile-dev`,
    `libsecret-1-dev`, `pkg-config`

### Build and run

```bash
nvm use
npm ci                 # first run takes 15–20 minutes (native modules)
npm run compile
./scripts/code.sh      # scripts\code.bat on Windows
```

### Lint and test

```bash
npm run eslint
./scripts/test.sh --grep Governance    # governance gate unit tests
```

### Package

Build each platform on its own OS; Electron native modules are not reliably
cross-compiled.

```bash
npm run gulp vscode-darwin-arm64-min   # or vscode-darwin-x64-min, vscode-win32-x64-min
```

Output is written beside the repository, e.g. `../VSCode-darwin-arm64`.

## Contributing

- Changes reach `main` through pull requests, and CI must pass.
- **Production-impacting actions — deploys, merges, and infrastructure changes
  on shared or remote clusters — require human sign-off.** Local Docker and
  dev-only actions are low-friction. This rule applies to the code this repo
  ships as well as to how it is developed; don't build shortcuts around it.
- Code follows upstream VS Code conventions (tabs, localized user-facing
  strings, disposables registered on creation). New files carry the
  Kete Workbench copyright header; upstream files keep Microsoft's.
- [CLAUDE.md](CLAUDE.md) holds the hard rules and known gotchas, and is the
  briefing file for AI coding assistants working in this repository.

`CONTRIBUTING.md` and `SECURITY.md` are still upstream's and are due to be
replaced. **Don't report security issues in this fork to Microsoft,** and don't
open public issues for them — contact the
[kete-org](https://github.com/kete-org) maintainers privately.

## Syncing with upstream

The `upstream` remote tracks `microsoft/vscode`. After merging upstream
changes:

1. Run `node apply-product-json.ts product.json` to restore the product
   identity and remove Microsoft endpoints if the merge overwrote them. It
   changes nothing when the branding is intact.
2. Check `product.json` has not regained other Microsoft endpoints or the
   Microsoft marketplace (`build/hygiene.ts` rejects the marketplace).
3. Keep upstream's workflows, CodeQL and Dependabot config out;
   `.github/workflows/build.yml` is the only workflow.
4. Confirm the two governance call sites —
   `ILanguageModelToolsService.invokeTool` and
   `ILanguageModelsService.sendChatRequest` — still exist and are still gated.
   The governance tests in CI fail if either stops calling the gate.

## License

[MIT](LICENSE.txt). Kete Workbench is built on Code - OSS, Copyright (c)
Microsoft Corporation; additions in this fork are Copyright (c) Kete Workbench
contributors. Third-party components are listed in
[ThirdPartyNotices.txt](ThirdPartyNotices.txt).

"Visual Studio Code" and "VS Code" are trademarks of Microsoft Corporation.
