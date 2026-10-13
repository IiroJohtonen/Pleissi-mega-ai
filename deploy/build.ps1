# Asentaa riippuvuudet ja kääntää käyttöliittymän ja palvelimen tuotantoa varten.
param([string]$Root = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = "Stop"
foreach ($part in "client", "server") {
  $dir = Join-Path $Root $part
  Write-Host "Asennetaan ja käännetään: $part"
  & npm ci --prefix $dir --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "Riippuvuuksien asennus epäonnistui kansiossa $part." }
  & npm run build --prefix $dir
  if ($LASTEXITCODE -ne 0) { throw "Kääntäminen epäonnistui kansiossa $part." }
}
