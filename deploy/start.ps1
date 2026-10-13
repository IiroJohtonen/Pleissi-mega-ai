# Käynnistää Kotilon tuotantotilassa ja pitää sen käynnissä: jos palvelin sammuu, se käynnistetään
# uudelleen. Sama palvelin tarjoaa rajapinnan ja käännetyn käyttöliittymän. Loki: logs\kotilo.log.
# Aja tuotantokopion kansiosta:  powershell -ExecutionPolicy Bypass -File deploy\start.ps1
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root "server"
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$log = Join-Path $logs "kotilo.log"

if (-not (Test-Path (Join-Path $server "dist\index.js"))) {
  throw "Palvelinta ei ole käännetty. Aja ensin deploy\build.ps1."
}

Set-Location $server
$env:NODE_ENV = "production"
while ($true) {
  Add-Content -Path $log -Value "$(Get-Date -Format s) Kotilo käynnistyy" -Encoding UTF8
  # cmd hoitaa ohjauksen tiedostoon, jotta lokiin tulee palvelimen oma UTF-8-teksti sellaisenaan.
  & cmd /c "node dist\index.js >> `"$log`" 2>&1"
  Add-Content -Path $log -Value "$(Get-Date -Format s) Kotilo sammui (koodi $LASTEXITCODE), uusi yritys 5 sekunnin kuluttua" -Encoding UTF8
  Start-Sleep -Seconds 5
}
