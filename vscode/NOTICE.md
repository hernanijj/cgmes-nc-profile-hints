# Notices

The files in `profiles/` are generated from ENTSO-E profile definitions:

- CGMES 2.4.15 RDFS (`*RDFSAugmented-v2_4_15-4Sep2020.rdf`), published by ENTSO-E.
- Network code profiles 2.2 RDFS and SHACL (`*Profile_v2_2_*`), published by ENTSO-E under the
  Apache License 2.0 (as declared in the RDFS metadata).

The source files are kept in `source-schemas/` and converted with `npm run build:profiles`.
The extension code itself is MIT licensed (see `LICENSE`). The extension bundles the
[n3](https://github.com/rdfjs/N3.js) Turtle parser (MIT).
