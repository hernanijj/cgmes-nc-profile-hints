![CGMES & NC Profile Hints logo](logo.svg)

# CGMES Editor Tools

Local preparation copy of the CGMES and network-code profile tools for:

- [Visual Studio Code](vscode/README.md)
- [Notepad++](notepadpp/README.md)

The projects currently keep separate copies of their core and profile bundles.
Their behavior and licenses should be reviewed before extracting a shared core.
Each project retains its own license and third-party notices.

## Profile sources

The copies include RDFS and SHACL files for CGMES 2.4.15, CGMES 3.0,
NCP 2.2, NCP 2.4 and NCP 2.5, as well as generated profile bundles and reference
data. They were sourced from ENTSO-E profile definitions; see the
[ENTSO-E CIM for grid model exchange page](https://www.entsoe.eu/digital/cim/cim-for-grid-models-exchange/).


## Test fixtures

Both projects include a synthetic RA XML fixture. Other fixtures can be found in [RelicapGrid](https://github.com/entsoe/ReliCapGrid)

