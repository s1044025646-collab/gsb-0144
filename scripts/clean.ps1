# Stop only the loopback demo/dev server recorded by THIS project and remove
# project-local data/build artifacts. Never touches unrelated processes.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot

$info = Join-Path $root 'data\server.json'
if (Test-Path $info) {
  $meta = Get-Content $info -Raw | ConvertFrom-Json
  if ($meta.pid) {
    $proc = Get-Process -Id ([int]$meta.pid) -ErrorAction SilentlyContinue
    if ($proc -and ($proc.Path -and $proc.Path -like "*$root*" -or $proc.ProcessName -like 'node*')) {
      Stop-Process -Id ([int]$meta.pid) -Force
      Write-Host "[clean] stopped project server pid $($meta.pid)"
    }
  }
}

foreach ($p in @('data', 'dist')) {
  $full = Join-Path $root $p
  if (Test-Path $full) {
    Remove-Item -LiteralPath $full -Recurse -Force
    Write-Host "[clean] removed $full"
  }
}
Write-Host '[clean] done'
