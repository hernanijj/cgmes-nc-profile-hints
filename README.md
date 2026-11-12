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
The versions included here have not been verified to be the latest available.

**Do not publish this copy yet.** Confirm the origin, redistribution rights
and applicable notices for each source and generated bundle. In particular,
the CGMES 2.4.15 manifest states that redistribution permission has not been
established. Review the separate Notepad++ CGMES 3.0 sources as well.
The [VS Code notices](vscode/NOTICE.md) and
[Notepad++ third-party notices](notepadpp/THIRD-PARTY.md) are starting points,
not a completed license audit.

## Test fixtures

Both projects include a synthetic RA XML fixture. Other fixtures should also
be reviewed before release.

No Git history or distribution packages were copied into this folder.
