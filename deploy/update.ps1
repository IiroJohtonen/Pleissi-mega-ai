# Päivittää tuotantokopion kehitysrepon uusimpaan versioon ja käynnistää palvelimen uudelleen.
# Aja tuotantokopion kansiosta:  powershell -ExecutionPolicy Bypass -File deploy\update.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "C:\Program Files\Git\cmd\git.exe" }

& $git -C $root pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "Päivitys epäonnistui. Tuotantokopiossa ei pidä olla omia muutoksia." }
& (Join-Path $PSScriptRoot "build.ps1") -Root $root

# Käynnissä oleva palvelin pysäytetään portin perusteella; start.ps1 käynnistää sen uudelleen itse.
$port = 4100
$envPath = Join-Path $root "server\.env"
if (Test-Path $envPath) {
  $line = Get-Content $envPath | Where-Object { $_ -match '^PORT=(\d+)' } | Select-Object -First 1
  if ($line) { $port = [int]($line -replace '^PORT=', '') }
}
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Stop-Process -Id $listener.OwningProcess -Force
  Write-Host "Palvelin pysäytettiin portista $port. Jos start.ps1 on käynnissä, uusi versio käynnistyy muutamassa sekunnissa."
} else {
  Write-Host "Palvelin ei ollut käynnissä. Käynnistä se komennolla deploy\start.ps1."
}
