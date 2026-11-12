# Third-party components

- CGMES core and schemas: copied from the adjacent CGMES & NC Profile Hints 0.1.10 project. Its MIT license is in `licenses/CGMES-LICENSE`. Profile data retains upstream notices; inspect the source project's schema provenance before redistribution.
- Notepad++ API header: https://github.com/notepad-plus-plus/notepad-plus-plus — GPL-3.0-or-later, notice retained in `vendor/Notepad_plus_msgs.h`.
- Scintilla headers: https://www.scintilla.org — license notices retained in the vendored files.
- nlohmann/json 3.11.3: https://github.com/nlohmann/json — MIT license retained in `vendor/json.hpp`.
- N3.js and bundled transitive modules: npm dependency licenses are included under `licenses/`.
- Node.js: the locally installed runtime is copied into the portable build; Node.js and third-party license text is in `licenses/Node-LICENSE`.

The native adapter is distributed under GPL-3.0-or-later to remain compatible with the Notepad++ header. The copied core keeps its original MIT license. No claim of endorsement by ENTSO-E, Notepad++, or the original schema providers is made.
