param([string]$Compiler='C:\msys64\mingw64\bin\g++.exe')
$ErrorActionPreference='Stop'
Push-Location $PSScriptRoot
try {
  node scripts/build.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Worker build failed' }
  if (-not (Test-Path -LiteralPath $Compiler)) { throw 'Supply -Compiler with the path to a MinGW-w64 g++.exe (x64).' }
  $env:PATH=(Split-Path $Compiler)+';'+$env:PATH
  & $Compiler -std=c++17 -O2 -shared -static -static-libgcc -static-libstdc++ -municode native/plugin.cpp -o dist/CGMESNotepad/CGMESNotepad.dll -lcomdlg32 -lcomctl32 -luser32 -lkernel32 -lshell32 -lole32 -lgdi32
  if ($LASTEXITCODE -ne 0) { throw 'Native DLL build failed' }
  New-Item -ItemType Directory -Force dist/CGMESNotepad/licenses | Out-Null
  Copy-Item licenses/* dist/CGMESNotepad/licenses -Recurse -Force
  Copy-Item README.md,THIRD-PARTY.md,LICENSE dist/CGMESNotepad -ErrorAction SilentlyContinue
  Compress-Archive -Path dist/CGMESNotepad -DestinationPath dist/CGMESNotepad-x64.zip -Force
} finally { Pop-Location }


