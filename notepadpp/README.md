![CGMES & NC Profile Hints logo](../logo.svg)

# CGMES & NC Profile Hints for Notepad++

Native **64-bit Windows / Notepad++** plugin, updated to the core of the adjacent VS Code extension **0.1.14**. The VS Code project is read-only during this build. No VS Code installation is required at runtime. Node.js and profile data are included in the portable distribution. The native plugin communicates with the Node worker using JSON lines over stdin/stdout; worker stdout is reserved for JSON responses.

Bundled profiles cover **CGMES 2.4.15**, **CGMES 3.0**, **NCP 2.2**, **NCP 2.4** and **NCP 2.5**, including version/profile choices. Automatic detection prefers exact header profile URIs before matching profile names, using the CIM namespace to disambiguate versions. NCP 2.4 and 2.5 use `https://cim.ucaiug.io/ns#` and `https://cim4.eu/ns/nc#`.

## Install

1. Close Notepad++.
2. Extract `dist/CGMESNotepad-x64.zip`.
3. Copy the entire `CGMESNotepad` directory into your Notepad++ `plugins` directory. The layout must be `plugins/CGMESNotepad/CGMESNotepad.dll`, alongside `node.exe`, `worker.cjs`, and `profiles/`.
4. Restart **64-bit** Notepad++. Open Plugins → CGMES & NC Profile Hints.


## Use
- Open `.xml`, `.rdf` or `.cimxml` for CIM hints. Validation runs only for `.xml` files; CIM `.rdf`/`.cimxml` files show **CIM validation requires a .xml file**, while generic RDF and schema/SHACL documents show **Not a supported CIM file** and receive no diagnostics. Edits trigger a background check after 700 ms. Profile status appears in the document-type status field; squiggles mark problems.
- Use **Complete CIM/XML** (Ctrl+Space; change conflicts in Shortcut Mapper), or type `<` or `"`. Completion defaults include identifiers and required properties. Tab/Shift+Tab navigate snippet fields; repeated numeric placeholders synchronize when leaving a field. Escape exits snippet navigation. Value suggestions remain available via Ctrl+Space.
- Hover after 700 ms, or choose **Show hover information**. Documentation appears in a plain-text Scintilla calltip.
- **Show issues** opens the bottom-docked results pane. An expandable tree separates Schema (RDFS), SHACL, cross-file references, reference data and file/identifier issues. Within each source, group by severity or check; the chosen grouping and collapsed branches are retained when results refresh. An issue caused by both schema and SHACL appears under both. Select an issue for details and double-click it or press **Apply / Go** to navigate.
- **Go to definition by mRID** asks for an identifier and lists matching CIM objects in the selected dataset. **Find references by mRID** searches `rdf:resource` references across the selected dataset; results show file and line in the bottom pane and can be double-clicked to navigate.
- **Object outline** and **Select profile/version** are also available from the menu.
- Choose **About CGMES & NC Profile Hints** in the plugin menu to see the installed Notepad++ plugin version.
- **Choose dataset files** accepts a multi-selection; **Choose open files to validate together** lets you select open CIM documents with checkboxes, including unsaved edits. Applying replaces the current dataset selection. `.xml` files are validated; `.rdf` and `.cimxml` files can be included as reference-only documents. **Choose dataset folder** selects its CIM files. **Show dataset files** lists membership, profiles and object counts. **Dataset: automatic** restores folder/header discovery. **Validate selected dataset** checks selected XML files, including closed files within the configured size limit. External file changes are rechecked every 2.5 seconds.
- The plugin keeps `%APPDATA%/CGMESNotepad/settings.json` internally to persist selected dataset files and per-document profile overrides. Advanced options such as extra folders or custom schemas can still be edited there; choose **Reload profiles and settings** afterward. The settings file is separate from VS Code settings.

## Settings

Use the VS Code setting names **without `cgmes.`**, as flat JSON keys. For example:

```json
{
  "version": "auto",
  "idStyle": "auto",
  "schemaFolders": [],
  "propertyReferenceList": "",
  "completion.insertRequiredProperties": true,
  "validation.enabled": true,
  "validation.requiredProperties": true,
  "validation.identifierFormat": true,
  "validation.propertyReferences": true,
  "validation.unresolvedReferences": "hint",
  "validation.danglingReferences": "warning",
  "crossFile.enabled": true,
  "crossFile.extraFolders": [],
  "crossFile.maxTotalSizeMB": 1000,
  "crossFile.maxValidateSizeMB": 60
}
```

Relative paths for extra folders, schema folders and reference lists resolve against the first document's folder when the worker starts. Set `workspaceFolder` to an absolute path to choose a stable base explicitly. `~` expands to the user home. `documentOverrides` and `datasetFiles` are maintained by menu selections. Profile choices select one profile at a time; multiple keywords can be supplied through `documentOverrides` in the settings file.

Set `version` to `auto`, `cgmes-2.4.15`, `cgmes-3.0`, `ncp-2.2`, `ncp-2.4` or `ncp-2.5`. Custom `schemaFolders` entries accept `folder`, `id`, `family`, `version` and `label`; an entry with the same `id` replaces a bundled package. Folders load RDFS `.rdf` and SHACL `.ttl` files. RDF files whose names contain `SHACL` or whose first 20,000 characters contain `<sh:NodeShape`/`sh:PropertyShape` are excluded from RDFS loading, following the VS Code loader. Conditional CGMES 3.0 `-Con-Complex-` Turtle rules contribute value constraints and notes without imposing their cardinalities on every object.

`validation.propertyReferences` defaults to `true`. Set it to `false` to disable NC `PropertyReference` name checks for both individual files and selected datasets; other validation checks remain active. `propertyReferenceList` selects a custom list; otherwise the bundled ENTSO-E list is used. Names are compared by `Class.property`, independent of the URI namespace.

## Parity and remaining work

| VS Code behavior | Notepad++ build |
|---|---|
| CGMES/NCP XML parsing, profile inference, RDFS/SHACL checks, reference data | Core synchronized with 0.1.14, excluding RDFS debug output; NCP 2.4 and 2.5 bundles included |
| Context completion, new IDs, required properties, enum/reference/value suggestions | Implemented, including Tab/Shift+Tab snippet fields and linked placeholder synchronization |
| Class/property hover documentation | Same content; Markdown displayed as text |
| Diagnostics and listed quick fixes | Implemented; one indicator color rather than severity-specific styling |
| Issues by source/severity/check, jump to issue | Native Notepad++ pane, docked left by default |
| Object outline and local definitions/references | Implemented |
| Cross-file validation with dependency preference and missing boundary handling | Shared index/validation semantics; worker caches disk scans by modification time/size |
| Unsaved sibling changes | All open tabs in both views are captured initially and after opening/saving; original active tabs/focus restored, later edits tracked |
| Automatic external-file monitoring | 2.5-second polling with cached disk indexing, plus refresh on editing and activation |
| Dataset selected files / automatic discovery | File/folder selection and membership display implemented |
| Large closed-file checks | Size limits enforced; files over validation limit are indexed only |
| Profile/version selection, templates, custom schemas, reload | Implemented; relative/home paths supported |
| Editor presentation | Native completion/calltips and left-docked results pane; no VS Code UI dependency |
| Full real-editor regression test | **Outstanding**; hidden host tests do not substitute for real Notepad++ acceptance |

As in the VS Code version, SPARQL SHACL constraints are documented but not executed; cross-file checks resolve identifiers/classes rather than performing a full merged-model SHACL validation.

New NCP 2.4 and 2.5 documents use the DatasetMetadata header: a `dcat:Dataset` with `dcterms:conformsTo` entries for DatasetMetadata and the selected application profile, plus the required dataset metadata fields. Legacy CGMES and NCP profiles continue to use `md:FullModel`. The NCP 2.4 and 2.5 bundles contain DatasetMetadata, so the shared template selects the appropriate header.

The first request briefly activates open tabs with redraw disabled to capture unsaved content, then restores both views and focus. Polling transfers editor snapshots to a separate worker; very large open datasets may incur copy/IPC overhead. Disk scans are cached, but this build has not been performance-qualified against gigabyte datasets.

## Build and checks

`powershell -ExecutionPolicy Bypass -File build.ps1` builds the worker, copies the Node runtime, compiles the DLL using `C:/msys64/mingw64/bin/g++.exe`, and packages the zip. Pass `-Compiler` to use another MinGW-w64 x64 compiler. Source builds use local `node_modules` when installed; otherwise they read the sibling `vscode` project's existing dependencies. No files there are written. `npm install` makes this project independently buildable.

Run `node scripts/build.cjs`, then `node out/test/adapter.test.js` and `node out/test/core.test.js`. Use direct Node execution in this environment: the `node --test` subprocess wrapper stalled here. The test files themselves use Node's test runner.


Build the host smoke test with `g++ -std=c++17 -static test/native-smoke.cpp -o out/native-smoke.exe -luser32 -lcomctl32`, then run `out/native-smoke.exe` from this project. It creates hidden host windows and loads the built DLL without touching a real Notepad++ installation.

`scripts/baseline.cjs` recompiles the sibling VS Code project's tests into this project's output without writing to VS Code. The original implementation audit snapshots are not included in this preparation copy because they contain machine-specific paths.

## Responsiveness and docking update

Issues and menu selections now use Notepad++ docking (left by default). Worker replies are read in 64 KB chunks; diagnostic line/byte positions are calculated in a single ordered pass. Interactive requests take priority over queued background validation. Native host tests cover profile menu results, docking registration and hover calltips; the user has also confirmed the plugin works in the real Notepad++ UI.


## Bounded hints and status profile picker

Hover hints wrap in a scrollable popup constrained to the Notepad++ client area and monitor work area. Move into the popup to scroll long messages. A resize that would leave the popup outside the window dismisses it. Click the bottom-left CGMES profile status text to open profile choices in the pane, including Automatic; double-click a choice or press Apply / Go.
