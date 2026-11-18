param(
  [string]$Gxx = "",
  [switch]$Install,
  [string]$NotepadPlusPlusDir = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$buildDir = Join-Path $root "build"
$distRoot = Join-Path $root "dist"
$stage = Join-Path $distRoot "RtlSignalPeek"

function Assert-ChildPath {
  param([string]$Child, [string]$Parent)
  $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  if ($childPath -eq $parentPath -or
      -not $childPath.StartsWith($parentPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe path: $childPath"
  }
}

if (-not $Gxx) {
  $candidates = @(
    (Get-Command g++ -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $Gxx = $candidates | Select-Object -First 1
}
if (-not $Gxx) {
  throw "g++ not found. Pass -Gxx <path-to-g++.exe>."
}

if ($Install -and -not $NotepadPlusPlusDir) {
  $notepadCandidates = @(
    $env:NOTEPAD_PLUS_PLUS_DIR,
    (Join-Path $env:ProgramFiles "Notepad++")
  )
  foreach ($drive in Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue) {
    if ($drive.Root) {
      $notepadCandidates += Join-Path $drive.Root "Program Files\Notepad++"
    }
  }
  $NotepadPlusPlusDir = $notepadCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ "plugins")) } |
    Select-Object -First 1
  if (-not $NotepadPlusPlusDir) {
    throw "Notepad++ not found. Pass -NotepadPlusPlusDir <path>."
  }
}

New-Item -ItemType Directory -Force -Path $buildDir, $distRoot | Out-Null

$dll = Join-Path $buildDir "RtlSignalPeek.dll"
& $Gxx -std=c++20 -O2 -shared -static -DUNICODE -D_UNICODE `
  -finput-charset=UTF-8 -fexec-charset=UTF-8 `
  -Ivendor (Join-Path $root "src\RtlSignalPeek.cpp") `
  -o $dll `
  -luser32 -lgdi32 -lcomctl32 -lshlwapi -lole32 -loleaut32 -luuid
if ($LASTEXITCODE -ne 0) {
  throw "Compilation failed with exit code $LASTEXITCODE"
}

if (Test-Path -LiteralPath $stage) {
  Assert-ChildPath -Child $stage -Parent $distRoot
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath $dll -Destination $stage
Copy-Item -LiteralPath (Join-Path $root "RtlSignalPeek.ini") -Destination $stage
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $stage
Copy-Item -LiteralPath (Join-Path $root "js") -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $root "tools") -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $root "demo") -Destination $stage -Recurse

$zip = Join-Path $distRoot "RtlSignalPeek.zip"
if (Test-Path -LiteralPath $zip) {
  Remove-Item -LiteralPath $zip -Force
}
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $stage | Select-Object -ExpandProperty FullName) -DestinationPath $zip

Write-Host "Built: $dll"
Write-Host "Package: $zip"

if ($Install) {
  if (Get-Process notepad++ -ErrorAction SilentlyContinue) {
    throw "Close Notepad++ before installing or updating the plugin."
  }
  $pluginsRoot = Join-Path $NotepadPlusPlusDir "plugins"
  if (-not (Test-Path -LiteralPath $pluginsRoot)) {
    throw "Notepad++ plugins directory not found: $pluginsRoot"
  }
  $target = Join-Path $pluginsRoot "RtlSignalPeek"
  Assert-ChildPath -Child $target -Parent $pluginsRoot
  $savedIni = $null
  $existingIni = Join-Path $target "RtlSignalPeek.ini"
  if (Test-Path -LiteralPath $existingIni) {
    $savedIni = Join-Path ([IO.Path]::GetTempPath()) ("RtlSignalPeek.ini." + [Guid]::NewGuid().ToString("N"))
    Copy-Item -LiteralPath $existingIni -Destination $savedIni
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item -Path (Join-Path $stage "*") -Destination $target -Recurse -Force
  if ($savedIni) {
    Copy-Item -LiteralPath $savedIni -Destination $existingIni -Force
    Remove-Item -LiteralPath $savedIni -Force
  }
  Write-Host "Installed: $target"
}
