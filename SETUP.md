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

Icons under `resources/darwin/`, `resources/win32/`, `resources/linux/`
still need your own branding assets — not yet done.

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
- No Kete agent loop yet. The governance gate service, risk classifier and
  audit log exist in `src/vs/platform/governance/` (with unit tests:
  `./scripts/test.sh --grep Governance`) but aren't wired into tool or model
  calls yet. The planned `kete-agent` extension hasn't been started. See
  `ARCHITECTURE.md` and D-003 in `DECISIONS.md`.
