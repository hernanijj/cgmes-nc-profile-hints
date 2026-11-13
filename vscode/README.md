![CGMES & NC Profile Hints logo](../logo.png)

# CGMES & NC Profile Hints

A VS Code extension that guides you while writing CIM/XML (RDF/XML) instance files for
**CGMES 2.4.15**, **CGMES 3.0** and the ENTSO-E **network code profiles (NCP) 2.2 and 2.5**. All hints come from the
official RDFS profile definitions and from the SHACL constraints (for CGMES 2.4.15, the ENTSO-E
QoCDC "EnhancedAppLibRDFS24" shapes; for CGMES 3.0, the ENTSO-E Application Profiles Library shapes).

For a concise introduction with examples, see `APRESENTACAO.md` in the project source.

## What it does

- **Completions**
  - Type `<` directly under `rdf:RDF` to get the concrete classes of the active profile. A new
    object comes with a fresh identifier (`rdf:ID="_uuid"` for CGMES 2.4.15 and 3.0,
    `rdf:about="urn:uuid:…"` for NCP) and its required properties already filled in as placeholders.
  - Type `<` inside an object to get the properties of that class (inherited ones included),
    with required ones listed first and properties that are already at their maximum left out.
  - Inside `rdf:resource="…"` you get the enumeration values, or the objects in the file whose class
    fits the association.
  - Inside an element you get `true`/`false`, the current date-time, profile URIs for
    `md:Model.profile`, and the object's own UUID for `IdentifiedObject.mRID`.
  - In an empty file, type `<` to pick a whole document skeleton (namespaces + header) for any profile.
- **Hovers** on class and property names show the description, inheritance, data type with unit,
  multiplicity, enumeration values, the profiles that carry it, and SHACL rules.
- **Diagnostics**
  - unknown class or property, and the wrong namespace (`cim:` vs `nc:` vs `entsoe:`), with a quick fix
  - class that is not in the file's profile, or that is abstract
  - property that belongs to a different class or to another profile
  - association end that is not exchanged (`cims:AssociationUsed No`)
  - literal vs `rdf:resource` mix-ups, wrong data type (Float, Integer, Boolean, DateTime, Duration, …)
  - invalid enumeration value, with a quick fix
  - NC `PropertyReference` values (for example `nc:GridStateAlteration.PropertyReference`): only the
    property part (`Switch.open`) is checked, whatever namespace precedes it, against the ENTSO-E
    [PropertyReference list](https://energy.referencedata.eu/PropertyReference/). A copy
    (PropertyReference-NCP 5.0.0, 188 names) ships in `profiles/property-references.rdf`;
    `cgmes.propertyReferenceList` points to another copy
  - reference to an object of the wrong class
  - too many occurrences, missing required properties (quick fix inserts them)
  - duplicate identifiers, malformed `_uuid` / `urn:uuid:` identifiers, undeclared prefixes
- **Cross-file checks** between the files of a dataset: a CGM's EQ, SSH, TP and SV (CGMES 2.4.15 or 3.0),
  or NC profiles that point to each other (AE to RA, CO to SIS/SSI, AE into EQ). Every CIM file in the
  same folder (plus `cgmes.crossFile.extraFolders`) is indexed in the background, and the open files
  are checked against it:
  - **dangling references**: `rdf:resource` to an object that is in none of the files
  - **wrong class across files**: `rdf:resource` to an object that another file defines with a class
    the association does not accept (the message names that file); classes of another CIM version
    (an NC 2.2 file pointing into a CGMES 2.4.15 EQ) are matched by name, and a class the NC profiles do not
    know (an NC 2.2 AE pointing to a CGMES 3.0 ACLineSegment) is judged with the CGMES 3.0 classes
  - **described objects** (`rdf:about="#_…"` in SSH, TP, SV): the object must exist in another file
    and have the same class
  - when the file depends (`md:Model.DependentOn`) on a model that is not in the folder, such as the
    boundary set, references it may hold stay plain "unresolved" hints instead of dangling warnings
  - **which files**: by default each file is checked first against the models its header depends on
    (`md:Model.DependentOn`, followed from SV to TP and SSH to EQ), then the rest of the folder. To choose
    yourself, select files or a folder in the Explorer and right-click **Validate together**, or click
    **Dataset** in the status bar and tick the files; **Automatic** in the same menu goes back. Files of a
    selection that are not open are validated from disk, and the CIM Issues view lists the files in use
  - the index reads files in 1 MB pieces and pauses between them, so the editor stays responsive; it is
    updated only for files that change, and open files are taken from the editor as you type
- **CIM Issues** view (Explorer sidebar): every error, warning, info and hint on the open file,
  split into **Schema (RDFS)**, **SHACL** (constraints only the SHACL shapes impose), **Cross-file
  references**, **Reference data** and **File and identifiers**, then grouped by severity or by check (button in the view title), with
  the line and the object it belongs to. A problem that breaks both the RDFS and a SHACL shape is listed
  under both sections (marked "also SHACL" / "also schema") but shown once in the editor. The Problems
  panel shows the same split in its source column (`CGMES schema`, `CGMES SHACL`, `CGMES schema + SHACL`, …). Click an issue to jump to it. The badge shows the total. Unlike the Problems panel, it also
  lists hints such as unresolved references. **CGMES: Show issues of this file** opens it.
- **Outline** of the objects grouped by class, **Go to Definition** and **Find References** for
  `rdf:resource` links. With a selected dataset, navigation searches all selected files; in automatic
  mode it remains within the current file. Other files are located from the background index, and
  reference positions are streamed only when requested.
- A status bar entry shows the version and profile in use; click it to change them for the file.

## How the version and profile are chosen

1. Your choice for the file (status bar or **CGMES: Select profile for this file**).
2. The header: every `md:Model.profile` (or `dcterms:conformsTo`) URI is matched to a profile.
   For CGMES 2.4.15 EQ, declaring `EquipmentOperation` or `EquipmentShortCircuit` makes the
   operation or short-circuit attributes required, as in the official profile variants. In CGMES 3.0
   Operation (`OP`) and ShortCircuit (`SC`) are profiles of their own, declared next to `CoreEquipment-EU`.
   An exact profile URI wins over a profile of the same name in another version, so a 3.0 SSH
   (`SteadyStateHypothesis-EU/3.0`) is never read as a 2.4.15 SSH.
3. The `cim` namespace (`CIM-schema-cim16#` → CGMES 2.4.15; `CIM100#` → CGMES 3.0 or NCP 2.2, told
   apart by the classes used).
4. The classes used in the file.

Required-property checks run only when the profile is known (header, your choice, or a clear match),
so a file without a header is not flooded with warnings.

## Commands

- **CGMES: New CIM/XML instance file**: pick a version and profile and get a skeleton with
  namespaces and a filled-in header.
- **CGMES: Select profile for this file** / **Select CIM version for this file**
- **CGMES: Reload profile definitions**

## Settings

| Setting | Default | |
|---|---|---|
| `cgmes.version` | `auto` | Force `cgmes-2.4.15`, `cgmes-3.0`, `ncp-2.2` or `ncp-2.5` (or the id of a folder you added). |
| `cgmes.schemaFolders` | `[]` | Extra RDFS (+ SHACL `.ttl`) folders, e.g. `[{"folder": "C:/schemas/ncp/2.4.1", "id": "ncp-2.4.1", "label": "NC profiles 2.4.1"}]`. |
| `cgmes.propertyReferenceList` | `""` | Path to a copy of the ENTSO-E PropertyReference list (RDF, Turtle, JSON, HTML, CSV or one `Class.property` per line). A file named `profiles/property-references.*` inside the extension is used when this is empty. |
| `cgmes.idStyle` | `auto` | `rdfID` or `urnUuid` for new objects. |
| `cgmes.completion.insertRequiredProperties` | `true` | Insert required properties with new objects. |
| `cgmes.validation.enabled` | `true` | |
| `cgmes.validation.requiredProperties` | `true` | |
| `cgmes.validation.identifierFormat` | `true` | |
| `cgmes.validation.propertyReferences` | `true` | Check NC `PropertyReference` values against the PropertyReference list (or the loaded profiles when there is none). |
| `cgmes.validation.unresolvedReferences` | `hint` | References that cannot be checked against the folder (cross-file checks off, no other CIM files there, or a model the file depends on is missing, e.g. the boundary set). Above 100 of them the editor shows one summary; the CIM Issues view lists each. |
| `cgmes.validation.danglingReferences` | `warning` | References and `rdf:about` descriptions to objects in none of the folder's files. Above 100 of them the editor shows one summary. |
| `cgmes.crossFile.enabled` | `true` | Check references against the other CIM files of the folder. |
| `cgmes.crossFile.extraFolders` | `[]` | More folders taking part, e.g. the boundary set or the EQ the NC files point to. |
| `cgmes.crossFile.maxTotalSizeMB` | `1000` | Stop indexing a folder beyond this total size. |
| `cgmes.crossFile.maxValidateSizeMB` | `60` | Files of a selected dataset that are not open are validated from disk up to this size; larger ones only resolve references. |

Files ending in `.xml`, `.rdf` or `.cimxml` are eligible for CIM hints when their content looks like
a CIM instance, but validation runs only for `.xml` files. For CIM `.rdf`/`.cimxml` files, the status
bar says **CIM validation requires a .xml file**; generic RDF and schema/SHACL documents are not
validated and show **Not a supported CIM file**.

## Adding more versions

Point `cgmes.schemaFolders` at a folder with RDFS files (any depth; SHACL `.ttl` files are picked up
too). The extension reads them when it starts, so NC 2.3/2.4/2.5 RDFS2020 files work
without rebuilding. To bundle a version into the extension instead, put its files under
`source-schemas/<family>/<version>/{schema,shapes}`, add it to `scripts/build-profiles.ts` and run
`npm run build:profiles`.

## What is not checked

SPARQL-based SHACL rules (for example "at least one of these associations") are not evaluated in the
editor, and cross-file checks look at identifiers and classes only (not, say, whether the SSH of an
object carries every value the EQ requires). The SPARQL rules are listed in the class hover so you
know they exist; run a full SHACL validator for those.

## Development

```bash
npm install
npm run build:profiles   # source-schemas/ -> profiles/*.json
npm test                 # unit tests (no VS Code needed)
npm run package          # dist/extension.js + cgmes-cim-hints-<version>.vsix
```

Press F5 in VS Code with this folder open to start an Extension Development Host.
`src/core/` has no VS Code dependency: XML scanner, RDFS/SHACL readers, analysis, validation,
completion and hover logic. `src/extension.ts` wires it into VS Code.
