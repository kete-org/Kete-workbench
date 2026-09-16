# Kete Workbench — Setup runbook

Run the local-iteration steps on your dev machine. CI (macOS + Windows
packaging) runs in GitHub Actions — see `.github/workflows/build.yml`,
already committed to the repo.

## 1. Clone the repo

The fork already exists at `kete-org/Kete-workbench` — this is not a
step you (or a new contributor) need to redo. Just clone it:

```bash
git clone git@github.com:kete-org/Kete-workbench.git
cd Kete-workbench
nvm install        # reads .nvmrc automatically
npm ci
```

## 2. Branding (`product.json`)

`product.json` is already patched and committed — a fresh clone gets it
for free. You only need to re-run the patch script if you're syncing in
changes from upstream `microsoft/vscode` and it's overwritten the
branding:

```bash
node apply-product-json.ts product.json
```

**`product.json.diff` is reference documentation only — never
`git apply` it.** It explains what changed and why; it isn't a real
patch file, and its line numbers won't match the actual file. `CLAUDE.md`
says the same — if you ever see instructions elsewhere telling you to
`git apply` it, that's stale and wrong.

The script only changes keys that differ, keeps upstream's tab formatting,
and saves the previous file as `product.json.bak` (gitignored). On an
already-branded `product.json` it changes nothing.

Icons are generated from `resources/kete-icon.svg`, with
`resources/kete-icon-small.svg` used at 32 px and under. After changing
either, regenerate and commit what it writes — CI packages the committed
files, it does not run this:

```bash
node generate-icons.ts
```

It needs macOS, because `.icns` is assembled by `iconutil` and the Inno Setup
bitmaps are converted by `sips`. The per-language file-type icons
(`resources/darwin/*.icns`, `resources/win32/*.ico`) are still upstream VS Code
artwork and are not generated yet.

## 3. First local build + smoke test

```bash
npm run compile
./scripts/code.sh    # needs a display — X11 forwarding over SSH, or a VNC
                      # session on the server; won't render headless
```

## 4. CI

Already wired — nothing to copy in. `.github/workflows/build.yml` runs
`lint-and-compile-check` (fast, Ubuntu) and the full macOS/Windows
`build` matrix automatically on pull requests and pushes to `main`. It also has
`workflow_dispatch`, so you can trigger a run manually from the Actions
tab without opening a PR if you just want to check the build itself.

**Not yet in this workflow, do before your first real distribution:**
- Code signing secrets (Apple Developer cert + notarization credentials
  as GitHub Actions secrets; Windows cert if you're not accepting the
  SmartScreen-warning tradeoff for now)
- Point `updateUrl` in `product.json` at your internal artifact host
  once one exists

## 5. Making changes: branch + PR, not a direct push to `main`

**`main` is protected by a repo ruleset — direct pushes are rejected.**
This isn't a bug to work around; treat it as the actual workflow:

```bash
git checkout -b your-change-name
# ... make changes, commit ...
git push -u origin your-change-name
```

Then open a PR against `main` on GitHub. This also means CI (`build.yml`)
runs against every proposed change automatically, which is the point —
don't look for a way to bypass the ruleset for convenience.

## 6. What's deliberately left out of this pass

- Extension gallery is pointed at Open VSX by default — verify licensing/
  availability of the extensions your team actually needs before relying
  on it exclusively.
- The governance gate gates every tool call and records every model request
  (tests: `./scripts/test.sh --grep Governance`, also run in CI), writes every
  decision to a durable audit store, and its settings can be pinned by admin
  policy. See `ARCHITECTURE.md` and D-003 in `DECISIONS.md`.
- Models and the agent are first increments. In a launched editor `@kete`
  answers chat with Kete Auto selected; the providers have been exercised
  against a real Ollama server, but not yet against a cloud vendor. To use
  them, set up at least one provider and chat with `@kete` (the default
  participant) using **Kete Auto**:
  - **Local (Ollama).** Run Ollama and point
    `kete.models.ollama.endpoint` at it. It defaults to
    `http://localhost:11434`, and any http(s) address works, including a
    server on your network. The setting is machine-scoped, so a workspace
    can't redirect model traffic. Pull a tools-capable model;
    `kete.models.ollama.model` picks which one Kete Auto uses when Ollama
    serves several.
    `kete.models.ollama.requestTimeout` (seconds, default 120, max 290) is how
    long to wait for the first token. A slow or shared server needs more: on a
    CPU-only machine a bare prompt answered in ~10 s but an agent prompt
    carrying the workbench's tools took ~175 s. Past ~300 s Node's networking
    stack ends the request whatever the setting says, so a server slower than
    that can't do local agent work (D-022).
  - **Claude.** Run **Kete: Set Claude API Key**.
  - **OpenAI, or any OpenAI-compatible endpoint.** Run **Kete: Set OpenAI API
    Key**. `kete.models.openai.endpoint` defaults to OpenAI itself and can
    point at Azure OpenAI, OpenRouter, vLLM or LM Studio instead;
    `kete.models.openai.midModel` and `kete.models.openai.frontierModel` name
    the models to use, because model names change and every server serves
    different ones (D-020).
  - With both cloud vendors set up, `kete.models.cloud.vendor` says which one
    Kete Auto tries first; the other is used when the first has no key, no
    model for the tier, or is unreachable. Both vendors' models stay in the
    model picker.

  Their unit tests run with
  `node --test "extensions/kete-models/out/test/**/*.test.js"` and
  `node --test "extensions/kete-agent/out/test/**/*.test.js"` after
  `npm run compile`.
- Copilot is not the default chat agent: `product.json` has no
  `defaultChatAgent`, so Copilot's setup and sign-in prompts don't appear
  (D-019). In a dev build the Copilot extension is still scanned from
  `extensions/copilot`; launch with `--disable-extension GitHub.copilot-chat`
  to match a packaged build.
