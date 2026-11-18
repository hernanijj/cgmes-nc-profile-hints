# Handover for Claude Code

## Repository at a glance

- Repository: `hernanijj/cgmes-nc-profile-hints`
- Workspace: `cgmes-editor-tools`, a local preparation copy containing two related products:
  - `vscode/`: VS Code extension
  - `notepadpp/`: native 64-bit Windows / Notepad++ plugin
- Current branch: `master`; current HEAD: `0975e66` (merge of the local Notepad++ packaging branch and remote `master`).
- Working tree was clean when this handover was written.
- `master` reports two commits ahead of `master/master`, but `master/master..HEAD` has no file diff. The two commits after HEAD are local "Agent host session ... baseline checkpoint" commits. Do not assume they contain code changes or push them without checking the current Git state.

## What this project does

The tools provide CIM/XML authoring support for CGMES and ENTSO-E network-code profiles: profile/version detection, completions, hovers, validation diagnostics, cross-file references, object navigation, and dataset selection. Profile knowledge is derived from bundled RDFS/SHACL sources and generated profile bundles rather than hard-coded class/property catalogs.

The root README describes bundled source/profile data for CGMES 2.4.15 and 3.0, NCP 2.2, 2.4, and 2.5. The VS Code and Notepad++ READMEs differ in what they claim is bundled or supported; check the actual profile bundles, manifests, and tests before making release claims.

## Important history and current state

- The VS Code extension is the original editor integration. It is version `0.1.15`.
- The Notepad++ project adds a native C++ plugin and a Node worker. The worker communicates with the plugin over JSON lines on stdin/stdout; stdout is reserved for worker responses. Its package version is also `0.1.15`.
- Recent upstream work added GitHub Actions CI and fixed tests for Windows checkout/line-ending behavior (`5f02fd8`, PR #3).
- The Notepad++ packaging work added a distributable x64 zip (`f0e20d1`, merged upstream as `c81c5ea`, PR #4). The local `0975e66` merge combines those changes.
- A `2.5-NC-support` branch exists. Check whether it is merged/relevant before using it as a source of truth.
- The Notepad++ project is not just a thin wrapper: its native UI and adapter are distinct, and it has a copied TypeScript core/profile data. The root README explicitly says the projects currently keep separate copies; synchronize behavior deliberately and keep both licenses and third-party notices intact.

## Source map and documentation

- Start with the root [`README.md`](README.md) for workspace/profile-source context.
- [`vscode/README.md`](vscode/README.md): extension behavior, settings and limitations.
- [`vscode/HOW_TO_DEVELOP.md`](vscode/HOW_TO_DEVELOP.md): core architecture, diagnostic codes, recipes and file map.
- [`vscode/TODO`](vscode/TODO): currently contains only “Add property reference to list of validations”. Property-reference parsing and validation are already present in both cores, so determine whether this TODO is stale or refers to displaying/grouping it in a particular validation list before implementing anything.
- [`notepadpp/README.md`](notepadpp/README.md): detailed Notepad++ usage, settings, parity, build/test commands, responsiveness work, and known limitations.
- VS Code core: `vscode/src/core/`; host/editor integration: `vscode/src/extension.ts`, `issuesView.ts`, `datasetService.ts`, `datasetUi.ts`, `profileStore.ts`.
- Notepad++ core: `notepadpp/src/core/`; worker adapter: `notepadpp/src/worker.ts`; native plugin: `notepadpp/native/`.
- Profile source files live under each product's `source-schemas/`; generated bundles are under `profiles/`.

## Build and test

GitHub Actions workflow: `.github/workflows/ci.yml`. It runs on `windows-latest` with Node.js 22, installs VS Code dependencies with `npm ci`, then runs both products' tests.

From `vscode/`:

```powershell
npm ci
npm test
npm run compile
npm run build:profiles
npm run package
```

From `notepadpp/`:

```powershell
npm test
```

`npm test` builds the worker and runs the adapter/core tests directly with Node. To build/package the native plugin, use:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

The default compiler is `C:\msys64\mingw64\bin\g++.exe`; pass `-Compiler` to select another x64 MinGW-w64 compiler. The Notepad++ README also documents a standalone hidden-host smoke test. Automated tests are not a substitute for acceptance in a real Notepad++ UI.

## Known limitations and cautions

- SPARQL-based SHACL constraints are documented but not evaluated. Cross-file checks resolve identifiers/classes; they are not full merged-model SHACL validation.
- Notepad++'s documented remaining work includes a full real-editor regression/acceptance test. Open-tab snapshot capture and polling may have noticeable overhead with very large datasets; performance has not been qualified for gigabyte-scale data.
- Notepad++ uses one diagnostic indicator color rather than severity-specific styling. Its issues/results pane is docked natively; it does not depend on VS Code at runtime.
- VS Code validation only runs for `.xml`; `.rdf` and `.cimxml` can be used as reference documents but are not validated. Verify current behavior in the relevant README before changing file handling.
- Do not edit `vscode/` as a side effect of a Notepad++ build: `notepadpp/README.md` states that it uses the sibling project's existing dependencies read-only when needed.
- Avoid treating generated `out/`, `dist/`, `.vsix`, or zip contents as source. Check `.gitignore`, tracking status, and the build scripts before changing generated artifacts.
- When changing profile behavior, update the relevant source data/build configuration and generated bundles, tests, and both READMEs where applicable. Keep the two implementations aligned only where behavior is intended to match.

## Suggested starting procedure

1. Check `git status`, branch/upstream, and the exact target editor before editing.
2. Read the editor-specific README and related tests; use `vscode/HOW_TO_DEVELOP.md` for core implementation guidance.
3. Treat the one-line `vscode/TODO` as unverified, not necessarily actionable.
4. Make a narrow change in the appropriate project, update directly related docs, and run the smallest relevant test; run both suites when changing shared/parity behavior.
