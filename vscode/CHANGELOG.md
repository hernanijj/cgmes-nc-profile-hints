# Changelog

## 0.1.16

- References are accepted when the target's class is in the SHACL value type list of the property
  (`sh:in` on the path `( property rdf:type )`), in any namespace the list names: CGMES 2.4.15 (`cim16`),
  CGMES 3.0 (`CIM100`) or NC. An NC `PinOperationalLimit.OperationalLimit` or `AssessedElement.OperationalLimit`
  pointing to a `CurrentLimit`, `VoltageLimit`, `ActivePowerLimit`… of a CGMES model is no longer reported as
  `reference-type`: the NC profiles declare these classes without their `OperationalLimit` superclass, so
  the RDFS alone rejected them. The same holds for any other class the NC RDFS repeats without inheritance
  (e.g. `TapChangerControl` as a `RegulatingControl`).
- A class missing from such a list is still judged by the RDFS, as before (the lists only name the classes
  of their own profile, e.g. `SvStatus.ConductingEquipment` lists only `CsConverter` and `VsConverter`). When
  both reject it, the problem says so: `[also SHACL sh:in …]`.
- The property hover shows the SHACL value types.

## 0.1.11

- **CGMES 3.0** is bundled (`profiles/cgmes-3.0.json`, built from `source-schemas/cgmes/3.0`): the 11 RDFS2020
  profiles (EQ, OP, SC, EQBD, SSH, TP, SV, DL, GL, DY, header) and the 74 SHACL files of the ENTSO-E
  Application Profiles Library. Hovers, completions, new-file templates, validation and the cross-file
  checks work for 3.0 as for 2.4.15.
- The version is chosen by exact profile URIs first, preferring the file's `cim` namespace, so a 3.0 SSH, TP,
  SV, DL, GL, DY or EQBD file is no longer taken for its 2.4.15 namesake. Without a header, `CIM100#` files are
  told apart (CGMES 3.0 or NC) by the classes used.
- CGMES 3.0 `-Con-Complex-` SHACL rules apply only to some classes or kinds of model, so their cardinalities are
  not used for required-property checks; their ranges, allowed values and classes are.
- An NC file pointing to an object of a class the NC profiles do not know (an AE pointing to a CGMES 3.0
  ACLineSegment or ConnectivityNode) has the reference judged with the CGMES 3.0 classes.
- New setting `cgmes.validation.propertyReferences` (default `true`) turns the NC `PropertyReference`
  check (`property-reference`) on or off, like the other validations.

## 0.1.10

- The identifier hint (`id-uuid`) says what is wrong and shows the expected format, e.g.
  `Identifier is not "_" + UUID: extra text "_LA_SLA_CLG" after the UUID.` followed by the identifier and
  `Expected: _xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (x = 0-9 or a-f; groups of 8-4-4-4-12)`. It also names
  a missing leading `_`, text before the UUID, a UUID without dashes, and groups of the wrong length or with
  non-hexadecimal characters. Identifiers without the leading `_` are now reported too.
- Switching between files no longer checks them again when nothing changed: results are kept per text
  and per state of the other files, a reopened file (VS Code closes preview tabs) reuses its analysis
  (up to 40 MB of recently closed files), and a file checked by "Validate together" keeps those results
  when it is opened. Before, opening the SSH or TP of the 50Hertz set checked the 32 MB EQ again each time
  (0.7 to 0.9 s); now nothing is re-checked.
- The CIM Issues view works out the object of an issue only when the issue is shown.

## 0.1.9

- Much faster on large files. Measured on a real 50Hertz IGM (EQ 32 MB, SSH 6 MB, TP 5 MB, SV 3 MB):
  opening the EQ until its problems show went from 8.3 s to 2.1 s, its outline from 3.4 s to 0.1 s, and
  "Validate together" on the four files from 13 s (with a 9 s freeze) to 2.4 s.
  - The CIM Issues view found the object of each issue with a linear search (thousands of issues times
    tens of thousands of objects); it is now a binary search and a lookup table.
  - The outline grouped objects with a quadratic copy.
  - The XML reader tests characters by code instead of a regular expression per character (twice as fast).
  - Property lists and required properties are worked out once per class instead of once per object.
  - Checks on the start of a document no longer copy the whole text (VS Code builds a new 32 MB string
    for every full read).
  - A file is validated at once when opened; the pause before re-checking while typing is shorter.
  - Timings of files that take more than 0.3 s are written to the CGMES output channel.
- References into a model missing further down the dependencies (TP depends on EQ, EQ on a boundary set
  that is not in the folder) are now unresolved hints instead of dangling warnings (1809 false warnings
  on the 50Hertz TP).

## 0.1.8

- **Choosing the files checked together (the dataset).**
  - Automatic (default): each file is checked first against the models its header depends on
    (`md:Model.DependentOn`, followed from SV to TP and SSH to EQ), so another hour's SSH or an older EQ in
    the same folder no longer answers for it; the rest of the folder still resolves what those lack.
  - **Validate together**: select files (or a folder) in the Explorer, right-click, and they are checked
    against each other only. Files that are not open are validated from disk (up to
    `cgmes.crossFile.maxValidateSizeMB`, 60 MB by default) and their problems show in the Problems panel.
    The selection is remembered per workspace.
  - **Dataset bar**: the status bar shows `Dataset: auto (n)` or `Dataset: n selected`; click it to tick the
    files, go back to automatic, or validate the selection again. The CIM Issues view lists the files in use
    with their profile, scenario time and problem counts, and says when a model the file depends on is missing.

## 0.1.7

- Cross-file checks: the other CIM files in the folder of the open file (a CGM's EQ, SSH, TP, SV, or NC
  profiles such as AE, RA, CO, SIS) are indexed in the background, and references are checked against
  them: dangling references (new `dangling-reference`, warning by default), references to an object of
  the wrong class in another file (`reference-type`, naming that file), and `rdf:about` descriptions of
  objects that are missing or of another class. References that may point into a model the file depends
  on but that is not in the folder (e.g. the boundary set) stay unresolved hints.
- The index reads files in 1 MB pieces and yields between them (a 374 MB CGM is indexed in about 4 s
  with the editor never blocked for more than about 30 ms), re-reads only changed files, and uses the
  editor's text for open files. New settings `cgmes.crossFile.enabled`, `cgmes.crossFile.extraFolders`,
  `cgmes.crossFile.maxTotalSizeMB` and `cgmes.validation.danglingReferences`.
- CIM Issues view: new **Cross-file references** section.

## 0.1.6

- A problem that breaks both the RDFS and a SHACL shape is now reported once in the editor with
  source `CGMES schema + SHACL` and the shape's constraint and message (`[also SHACL sh:maxCount 1: …]`),
  and the CIM Issues view lists it under both Schema and SHACL, marked "also SHACL" / "also schema".
  Covers data types, enumerations (sh:in), reference types (sh:class) and min/max counts.

## 0.1.5

- Files with many references to objects in other files (for example NC AssessedElement files pointing
  into EQ) no longer hit VS Code's limit of 1000 problems per file: the editor gets one summary for
  more than 100 unresolved references, and errors and warnings are kept first if the list is still too
  long. The CIM Issues view always lists every problem; long groups start folded.

## 0.1.4

- Every diagnostic says where its rule comes from: RDFS schema, SHACL, reference data, or CIM/XML file
  rules. The CIM Issues view shows these as separate sections, and the Problems panel source reads
  `CGMES schema`, `CGMES SHACL`, `CGMES reference data` or `CIM/XML`. A problem is listed under SHACL
  only when the RDFS alone would accept it.

## 0.1.3

- CGMES 2.4.15 now uses the ENTSO-E QoCDC SHACL shapes (`CGMES_v2_4_constraints/EnhancedAppLibRDFS24`),
  copied to `source-schemas/cgmes/2.4.15/shapes`: their messages appear in diagnostics and hovers,
  `PhaseTapChanger.TransformerEnd` / `RatioTapChanger.TransformerEnd` must point to a
  `PowerTransformerEnd`, and inverse association ends are limited to 0 occurrences.
- SHACL files are matched to profiles also when the names differ by a plural (StateVariables / StateVariable);
  EquipmentCore* variant shapes are skipped because the full EquipmentProfile shapes are used.

## 0.1.2

- New **CIM Issues** view in the Explorer: all diagnostics of the open file grouped by severity or by
  check, with line and object; click to jump. Command **CGMES: Show issues of this file**.

## 0.1.1

- NC `PropertyReference` values are checked by their property name only (the namespace is ignored),
  against the ENTSO-E PropertyReference list set in `cgmes.propertyReferenceList`, or against the
  properties of the loaded CIM profiles when no list is set. Completion offers the names and a quick
  fix replaces a misspelt one.
- Bundles the ENTSO-E PropertyReference list (PropertyReference-NCP 5.0.0) in `profiles/property-references.rdf`.

## 0.1.0

- First version: completions, hovers, diagnostics, quick fixes, outline and go-to-definition
  for CIM/XML files following CGMES 2.4.15 and NC profiles 2.2.
- Extra RDFS/SHACL folders can be loaded with `cgmes.schemaFolders`.
