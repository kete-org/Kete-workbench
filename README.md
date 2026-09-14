# Kente Workbench

[![Build](https://github.com/kete-org/Kete-workbench/actions/workflows/build.yml/badge.svg)](https://github.com/kete-org/Kete-workbench/actions/workflows/build.yml)

A code editor with an embedded, governance-aware coding agent, built for
African developer economics: cost-tiered model routing, offline-first
operation, and support for low-spec hardware.

Kente Workbench is a fork of [`microsoft/vscode`](https://github.com/microsoft/vscode)
("Code - OSS"). It is an independent project and is not affiliated with or
endorsed by Microsoft.

> **"Kente Workbench" is a working name** and may change before the first
> release. See [D-000 in DECISIONS.md](DECISIONS.md#d-000--the-name-kente-workbench-is-provisional).

## Status

Early development — **there is no installable release yet.** The project is in
Tier 0 (foundation).

| Area | State |
|---|---|
| Editor shell rebrand (`product.json`) | Done; some upstream identifiers remain (URL protocol, Windows AppIds) pending the final name |
| Extension gallery → Open VSX | Done |
| Telemetry off by default | Done |
| Native packaging CI (macOS arm64/x64, Windows x64) | In progress — not yet green |
| Governance gate, risk classifier, audit log | Implemented and unit-tested in `src/vs/platform/governance/`; not yet wired into tool or model calls |
| Product icons | Still upstream VS Code artwork |

## How it differs from Code - OSS

- **Extensions come from [Open VSX](https://open-vsx.org).** Microsoft's
  marketplace terms don't permit use by forks, so extensions published only
  there — including Microsoft's Remote-SSH — are unavailable.
- **Telemetry is off by default** (`enableTelemetry: false`). Any future
  collection requires a documented opt-in.
- **The built-in GitHub Copilot extension is not packaged.** It reaches models
  directly rather than through the governance gate.
- **Agent actions are designed to pass through one governance gate.** Tool
  execution and model requests will funnel through a single chokepoint that
  applies approval gates and writes an audit log. Organisation policy
  overrides user and project settings, so a repository cannot lower the bar
  for its own code. The gate exists today; wiring it into those two call sites
  is the next step.

## Architecture

```
IDE shell → agent orchestrator → governance gate → capability layer → integrations
                                  (approval + audit)  (model routing, retrieval,
                                                       tools & infra, skills & hooks)
```

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design and the tiered feature roadmap
- [DECISIONS.md](DECISIONS.md) — decisions and their rationale, including why the
  gate lives in `src/vs/platform/` rather than in an extension (D-003)

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
  Kente Workbench copyright header; upstream files keep Microsoft's.
- [CLAUDE.md](CLAUDE.md) holds the hard rules and known gotchas, and is the
  briefing file for AI coding assistants working in this repository.

`CONTRIBUTING.md` and `SECURITY.md` are still upstream's and are due to be
replaced. **Don't report security issues in this fork to Microsoft,** and don't
open public issues for them — contact the
[kete-org](https://github.com/kete-org) maintainers privately.

## Syncing with upstream

The `upstream` remote tracks `microsoft/vscode`. After merging upstream
changes:

1. Check `product.json` has not regained Microsoft endpoints or the Microsoft
   marketplace (`build/hygiene.ts` rejects the marketplace).
2. Confirm the two governance call sites —
   `ILanguageModelToolsService.invokeTool` and
   `ILanguageModelsService.sendChatRequest` — still exist and are still gated.

## License

[MIT](LICENSE.txt). Kente Workbench is built on Code - OSS, Copyright (c)
Microsoft Corporation; additions in this fork are Copyright (c) Kente Workbench
contributors. Third-party components are listed in
[ThirdPartyNotices.txt](ThirdPartyNotices.txt).

"Visual Studio Code" and "VS Code" are trademarks of Microsoft Corporation.
