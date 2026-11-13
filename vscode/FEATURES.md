# CGMES & NC Profile Hints: what it does (v0.1.11)

Covers **CGMES 2.4.15** (13 RDFS files + 13 QoCDC SHACL files), **CGMES 3.0** (11 RDFS2020 files + 74 SHACL
files of the ENTSO-E Application Profiles Library) and **NC profiles 2.2** (19 RDFS files + SHACL), plus any extra RDFS/SHACL folder you add with `cgmes.schemaFolders`.

## Validations

Each problem carries a code (search it in `src/core/validate.ts`) and the rule set it comes from.

### File and identifiers (`CIM/XML`)
| Code | Severity | Checks |
|---|---|---|
| `xml` | error | XML is well formed (unclosed tags, bad attributes…) |
| `undeclared-prefix` | error | a prefix such as `nc:` is used without `xmlns:nc` |
| `unknown-header-profile` | warning | a `md:Model.profile` / `dcterms:conformsTo` URI matches no known profile |
| `duplicate-id` | error | two objects with the same `rdf:ID` / `rdf:about` |
| `missing-id` | error | object without `rdf:ID` or `rdf:about` |
| `id-ncname` | error | `rdf:ID` is not a valid XML name (e.g. starts with a digit) |
| `id-uuid` | hint / warning | identifier is not `_` + UUID (CGMES) or a valid `urn:uuid:` (NC) |
| `unresolved-reference` | hint (setting) | `rdf:resource="#…"` points to an object not in this file (normal for EQ/boundary); more than 100 become one summary in the editor |
| `more-issues` | info | more than 1000 problems: the editor keeps errors and warnings first; the CIM Issues view lists all |

### Schema (RDFS profile definitions)
| Code | Severity | Checks |
|---|---|---|
| `unknown-class` | error | class does not exist in the version |
| `wrong-namespace` | error | right name, wrong prefix (`cim:` vs `nc:` vs `entsoe:`), with quick fix |
| `class-not-in-profile` | warning | class exists but not in the file's profile (e.g. `SvVoltage` in EQ) |
| `abstract-class` | warning | class is not concrete in the profile |
| `unknown-property` | error | property does not exist; suggests the closest one, with quick fix |
| `property-wrong-class` | error | property belongs to another class |
| `property-not-in-profile` | warning | property exists but is exchanged in another profile |
| `association-not-exchanged` | warning | the non-exchanged end of an association was used |
| `too-many` | error | more occurrences than the multiplicity allows |
| `missing-required` | warning | required properties missing (follows EQ Operation/ShortCircuit declared in the header), quick fix inserts them |
| `expected-literal` / `expected-resource` | error | `rdf:resource` used for an attribute, or text for an association/enum |
| `empty-value` | warning | attribute with no value |
| `fixed-value` | warning | attribute with a fixed value (`cims:isFixed`) has another value |
| `datatype` | error | value does not match Float, Decimal, Integer, Boolean, Date, DateTime, DateTimeStamp, Duration, MonthDay, Time, URI |
| `enum-value` | error | value is not in the enumeration, with quick fix |
| `reference-type` | error | `rdf:resource` points to an object of the wrong class; a class named in the property's SHACL value type list (`sh:in` on `( property rdf:type )`, any CIM namespace) is always accepted |

### SHACL
- Constraints only SHACL imposes: `pattern`, `range` (min/max inclusive/exclusive), `max-length`, stricter
  `sh:minCount` / `sh:maxCount`, `sh:in`, `sh:class` (e.g. tap changer end must be a `PowerTransformerEnd`)
  and `sh:datatype` when the RDFS has none.
- SHACL value type lists (`sh:in` on the path `( property rdf:type )`) accept the classes they name, from
  CGMES 2.4.15, CGMES 3.0 or NC, even when the RDFS of the file's version does not give their inheritance
  (an NC `PinOperationalLimit.OperationalLimit` pointing to a CGMES `CurrentLimit`). Classes not in the list
  are left to the RDFS check, since the lists only name the classes of their own profile.
- When the RDFS and SHACL both reject a value (data type, enumeration, reference type, counts), it is one
  problem with source `CGMES schema + SHACL` and `[also SHACL …: <shape message>]`, listed under both sections.
- SPARQL-based shapes are not evaluated; they are listed in the class hover.

### Cross-file references (`CGMES dataset`)
The other CIM files of the folder (and `cgmes.crossFile.extraFolders`) are indexed in the background:
EQ + SSH + TP + SV of a CGM, or NC profiles referencing each other (AE→RA, CO→SIS/SSI, AE→EQ).
| Code | Severity | Checks |
|---|---|---|
| `dangling-reference` | warning (setting) | `rdf:resource` or `rdf:about="#_…"` to an object in none of the files; more than 100 become one summary in the editor |
| `reference-type` | error | `rdf:resource` to an object another file defines with the wrong class ("defined in EQ.xml"; listed under Schema/SHACL); `rdf:about` describing an object that is of another class in its file |
| `unresolved-reference` | hint | instead of dangling when the file's `md:Model.DependentOn` names a model not in the folder (e.g. the boundary set) |

**Which files (dataset):** automatic by default (the models in `md:Model.DependentOn`, followed from model to
model, are preferred; the rest of the folder resolves what they lack), or chosen with Explorer right-click
**Validate together** / the **Dataset** status bar entry (checked against each other only; files not open are
validated from disk up to `cgmes.crossFile.maxValidateSizeMB`). The CIM Issues view shows the files in use.

Classes of another CIM version (NC 2.2 → CGMES 2.4.15 EQ) are matched by name; a class the NC profiles do
not know (NC 2.2 AE → CGMES 3.0 ACLineSegment) is judged with the CGMES 3.0 classes. The index is built by
a regular-expression scan of start tags, read in 1 MB pieces with pauses, cached by file date and size.

### Reference data
| Code | Severity | Checks |
|---|---|---|
| `property-reference` | error / warning | NC `PropertyReference` values: only the `Class.property` part is checked, any namespace, against the ENTSO-E list (bundled `profiles/property-references.rdf`, 188 names, or `cgmes.propertyReferenceList`); quick fix for misspellings |

## Editing help
- **Completion**: classes after `<` at top level (new object with fresh `_uuid` / `urn:uuid:` and required
  properties filled in); properties inside an object (required first, full ones left out); enum values and
  matching objects inside `rdf:resource`; PropertyReference names; `true/false`, current date-time,
  profile URIs, the object's own mRID; whole document skeletons in an empty file.
- **Hover**: description, inheritance, data type and unit, multiplicity, enum values, profiles, SHACL rules.
- **Quick fixes**: namespace / property / enum / PropertyReference replacements, declare a missing `xmlns`,
  insert missing required properties.
- **Navigation**: outline grouped by class, Go to Definition and Find References for `rdf:resource`;
  both search every file in an explicitly selected dataset, and stay file-local in automatic mode.

## Views and commands
- **CIM Issues** (Explorer): sections Schema (RDFS), SHACL, Cross-file references, Reference data, File and identifiers; inside each,
  group by severity or by check; line and object per issue; click to jump; badge with the total.
- **Status bar**: version and profile in use; click to change them for the file.
- Commands: New CIM/XML instance file, Select profile, Select CIM version, Reload profile definitions,
  Show issues of this file, Validate together (Explorer), Dataset… (status bar).

## How version and profile are chosen
Your choice for the file, then the header (`md:Model.profile` / `dcterms:conformsTo`), then the `cim`
namespace (`cim16#` = CGMES 2.4.15, `CIM100#` = CGMES 3.0 or NCP 2.2), then the classes used. Exact
profile URIs win over a profile of the same name in another version (3.0 SSH vs 2.4.15 SSH).

### CGMES 3.0 SHACL
The `-Con-Simple-` files give cardinalities, datatypes and allowed values. The `-Con-Complex-` files hold
rules for some classes or kinds of model only (node-breaker, solved or not solved MAS): their value rules
(ranges, allowed values, classes) are checked and their SPARQL rules shown in hovers, but their
cardinalities are not applied to every object.

## Settings
`cgmes.version`, `cgmes.schemaFolders`, `cgmes.propertyReferenceList`, `cgmes.idStyle`,
`cgmes.completion.insertRequiredProperties`, `cgmes.validation.enabled`, `cgmes.validation.requiredProperties`,
`cgmes.validation.identifierFormat`, `cgmes.validation.propertyReferences`, `cgmes.validation.unresolvedReferences`, `cgmes.validation.danglingReferences`,
`cgmes.crossFile.enabled`, `cgmes.crossFile.extraFolders`, `cgmes.crossFile.maxTotalSizeMB`, `cgmes.crossFile.maxValidateSizeMB`.

## Not covered
SPARQL SHACL rules, cross-file checks beyond identifiers and classes, CGMES 3.0 and newer NC
versions unless you add their folders.
