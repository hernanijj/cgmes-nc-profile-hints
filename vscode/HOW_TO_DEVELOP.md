# How the hints work, and how to change them

## 1. The big picture

Every time you type in a CIM/XML file, this runs (in `src/extension.ts`):

```
your .xml text
   │
   ▼
analyze()  ── src/core/analysis.ts
   │  • parses the XML (src/core/xml.ts), keeping character positions
   │  • lists the objects (children of rdf:RDF) and their rdf:ID / rdf:about
   │  • picks the version (CGMES 2.4.15 / 3.0 / NCP 2.2) and the profile (EQ, SSH, RA…)
   │    from md:Model.profile in the header, else the cim namespace
   ▼
"Analysis" object ──────────────┬───────────────┬──────────────┐
   ▼                            ▼               ▼              ▼
validate()                  complete()       hover()      outline / go-to
src/core/validate.ts        complete.ts      hover.ts     extension.ts
→ squiggles + Problems      → suggestions    → tooltips
```

The knowledge about classes and properties does **not** live in the code. It comes from your RDFS and SHACL files:

```
source-schemas/cgmes/2.4.15/schema/*.rdf     ─┐                            profiles/cgmes-2.4.15.json
source-schemas/cgmes/3.0/schema/*.rdf         │                            profiles/cgmes-3.0.json
source-schemas/cgmes/3.0/shapes/*.ttl (SHACL) ├─ npm run build:profiles ─►  profiles/ncp-2.2.json
source-schemas/ncp/2.2/schema/*.rdf           │   (src/core/rdfs.ts,
source-schemas/ncp/2.2/shapes/*.ttl (SHACL)  ─┘    src/core/shacl.ts)
```

Each class in the JSON has its description, superclasses and a concrete/abstract flag. Each property has its
domain class, type (attribute / association / enum), primitive (Float, Boolean…), multiplicity, and the
SHACL extras (min/max count, allowed values, messages).
`src/core/profileIndex.ts` answers questions about that data: "which properties does ACLineSegment have
in EQ, including inherited ones?", or "is a BaseVoltage a ConductingEquipment?".

So there are two kinds of change:

| You want to… | Change |
|---|---|
| fix what a class or property *is* (multiplicity, type, new version) | the RDFS/SHACL files, then run `npm run build:profiles` |
| change *how* things are checked or suggested | the TypeScript in `src/core/` |

## 2. Finding the code behind a warning

In the Problems panel every message ends with its code, for example `cgmes(abstract-class)`.
Search for that code in `src/core/validate.ts` (`Ctrl+Shift+F`, type `'abstract-class'`) and you land on the
line that produces it.

| Code | What it checks |
|---|---|
| `undeclared-prefix` | `nc:` used without `xmlns:nc` |
| `duplicate-id`, `missing-id`, `id-ncname`, `id-uuid` | identifiers |
| `unknown-class`, `wrong-namespace` | class or property not in the version (with "did you mean") |
| `class-not-in-profile`, `abstract-class` | class exists but not in this profile, or is abstract |
| `unknown-property`, `property-wrong-class`, `property-not-in-profile` | property problems |
| `association-not-exchanged` | the inverse end of an association was used |
| `too-many`, `missing-required` | multiplicity |
| `expected-literal`, `expected-resource` | text vs `rdf:resource` |
| `datatype`, `range`, `max-length`, `pattern`, `empty-value`, `fixed-value` | attribute values |
| `enum-value` | enumeration values |
| `property-reference` | NC `PropertyReference` values, by property name only (`src/core/propertyReference.ts`) |
| `unresolved-reference`, `reference-type` | `rdf:resource="#…"` targets |

How `validate()` is laid out:
- The top part checks the whole file: prefixes, header and duplicate IDs.
- `for (const o of a.objects)` loops over every object and checks its ID and class.
- Inside it, `for (const c of el.children)` loops over the object's properties.
- `checkValue()`, further down, checks one property's value: data type, enum, reference.
- `PRIMITIVE_CHECKS`, near the top, holds the regular expressions for Float, Integer, Boolean, DateTime and so on.

## 3. Recipes

Each problem also has a `rule`: `'schema'` (RDFS), `'shacl'` (only a SHACL shape forbids it), `'reference'`
or `'file'`. Most codes get it from `RULE_OF_CODE` at the top of `validate.ts`; checks that can come from
either side (`datatype`, `enum-value`, `reference-type`, `too-many`, `missing-required`) set it themselves.
`rules` lists every rule set a problem breaks; `alsoShacl()` in `validate.ts` marks a schema problem that a SHACL
shape rejects too. The CIM Issues view and the Problems source column use it.

### a) Change a message or a severity
Edit the `message:` or `severity:` (`'error' | 'warning' | 'info' | 'hint'`) of the `out.push({...})` for that code.

### b) Add your own rule (example: CGMES 2.4.15 names are at most 32 characters)
In `src/core/validate.ts`, find the line `checkValue(a, c, prop, opts, out);` inside the property loop and add below it:

```ts
      if (prop.label === 'IdentifiedObject.name') {
        const name = textContent(a.doc, c).trim();
        if (name.length > 32) {
          out.push({ start: c.nameStart, end: c.nameEnd, severity: 'warning', code: 'name-too-long',
            message: `IdentifiedObject.name should be at most 32 characters (found ${name.length}).` });
        }
      }
```

What the names mean there:
- `c` is the property element. `c.nameStart` and `c.nameEnd` are where the squiggle goes.
- `prop` is its definition from the profile: `prop.label`, `prop.primitive`, `prop.min`, `prop.max`, `prop.range`.
- `o` is the object, and `o.type` is its class URI.
- `a.active` is the list of active profiles. For example, `a.active.some(p => p.keyword === 'EQ')` checks for EQ.
- `a.index.isA(o.type, someClassUri)` tests inheritance.

Press `Ctrl+Shift+F5` in the main window, and the test window reloads with your rule.

### c) Change what is suggested
- `src/core/complete.ts`:
  - `tagNames()` builds the list after `<`.
  - `resourceValues()` builds the list inside `rdf:resource=""`.
  - `textValues()` suggests values between tags (true/false, dates, profile URIs).
- `src/core/templates.ts`:
  - `objectSnippet()` is the text inserted for a new object.
  - `propertySnippet()` is the text for one property.
  - `placeholder()` gives the default values, for example `0.0` for a Float.
  - `headerSnippet()` is the `md:FullModel` header.

Snippet syntax: `${1:text}` is a Tab stop, `${1|a,b|}` is a dropdown, and `$0` is where the cursor ends.

### d) Change the hover text
`src/core/docs.ts`: `classMarkdown()` builds the class hover and `propMarkdown()` builds the property hover.

### e) Change the profile data
Edit or replace files under `source-schemas/…`, then run `npm run build:profiles` and press `Ctrl+Shift+F5`.
To use another version without rebuilding, add its folder to the `cgmes.schemaFolders` setting.

### f) Add another NC profiles version
Replace `2.x` with the version, for example `2.4`. Run the commands in a terminal opened in the extension folder.

1. Create the folder `source-schemas/ncp/2.x`.
2. Create the folder `source-schemas/ncp/2.x/schema`.
3. Create the folder `source-schemas/ncp/2.x/shapes` (the SHACL folder; it must be called `shapes`).
4. Copy the version's RDFS files (`…_RDFSv2020_….rdf`) into `source-schemas/ncp/2.x/schema`. Keep the original file names.
5. Copy the version's SHACL files (`…_SHACL.ttl`) into `source-schemas/ncp/2.x/shapes`. Keep the original file names.
6. Open `scripts/build-profiles.ts`.
7. In the `PACKAGES` list, add this line under the `ncp-2.2` line, and save:
   ```ts
   { id: 'ncp-2.x', family: 'NCP', version: '2.x', label: 'NC profiles 2.x', idStyle: 'urnUuid', dir: 'source-schemas/ncp/2.x' },
   ```
8. Run `npm run build:profiles`.
9. Check that the output has a line `NC profiles 2.x: AE(…c/…p) …` listing every profile of the version.
10. Check that the file `profiles/ncp-2.x.json` was created.
11. Open `package.json`, raise `"version"` (for example `0.1.11` to `0.1.12`), and save.
12. Run `npm test`.
13. Press `F5` and open an NC 2.x file in the window that opens: the status bar shows `NC profiles 2.x`.
14. Run `npm run package`. The extension is the new `cgmes-cim-hints-<version>.vsix` in the extension folder.

For a CGMES version, do the same under `source-schemas/cgmes/<version>` with `family: 'CGMES'` and `idStyle: 'rdfID'`.

## 4. Debugging step by step
1. Set a breakpoint by clicking left of a line number, for example inside `validate()`.
2. Press F5, then type in the test window. VS Code stops on your breakpoint.
3. Hover variables to inspect them, or use the Debug Console.

The **CGMES** entry in the Output panel (in the test window) shows which schema folders were loaded.

## 5. Tests
`npm test` runs `test/core.test.ts` against the sample files in `test/fixtures/`.
When you add a rule, add a case there too. Copy one of the existing `test(...)` blocks and assert that your
`code` shows up for a bad snippet.

## 6. File map
```
src/extension.ts        VS Code wiring: diagnostics, completion, hover, quick fixes, commands, status bar
src/issuesView.ts       the "CIM Issues" sidebar view (built from the diagnostics)
src/profileStore.ts     loads profiles/*.json and the cgmes.schemaFolders folders
src/datasetService.ts   background index of the other CIM files of each folder (watches them, live for open files)
                        and which files a file is checked against (automatic from DependentOn, or selected)
src/datasetUi.ts        dataset bar: status bar entry, "Validate together", file picker
src/core/xml.ts         error-tolerant XML scanner with character positions
src/core/rdfs.ts        RDFS → classes/properties
src/core/shacl.ts       SHACL → extra constraints and messages
src/core/bundle.ts      groups the profiles of one version (EQ sub-profiles, duplicate files)
src/core/profileIndex.ts lookups: inheritance, properties per class, header → profile
src/core/analysis.ts    reads one document: objects, IDs, version and profile detection
src/core/validate.ts    all diagnostics
src/core/complete.ts    suggestions
src/core/templates.ts   inserted text (objects, properties, header, new file)
src/core/docs.ts        hover / documentation text
src/core/hover.ts       hover, go-to-definition, find references
src/core/propertyReference.ts  reads the PropertyReference list and checks Class.property names
src/core/crossIndex.ts  fast start-tag scanner (id → class per file) and the lookup used by validate.ts
                        (cross-file checks: search 'dangling-reference' and checkDescribedObject in validate.ts)
scripts/build-profiles.ts  source-schemas → profiles/*.json
package.json            settings, commands, npm scripts
```
