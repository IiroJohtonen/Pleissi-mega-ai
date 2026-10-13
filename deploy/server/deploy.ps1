# Vie Kotilon nykyisen version palvelimelle ja käynnistää sen. Sama komento asentaa ensimmäisellä
# kerralla ja päivittää myöhemmin. Aja kehitysrepon juuresta:
#   powershell -ExecutionPolicy Bypass -File deploy\server\deploy.ps1 -Server root@PALVELIMEN-IP
param(
  # SSH-osoite, esim. root@94.237.12.34
  [Parameter(Mandatory = $true)][string]$Server
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "C:\Program Files\Git\cmd\git.exe" }

# Palvelimelle viedään viimeisin commit, ei työkansion keskeneräisiä muutoksia.
$dirty = & $git -C $root status --porcelain
if ($dirty) { Write-Host "Huom: työkansiossa on tallentamattomia muutoksia, joita ei viedä palvelimelle." }
$version = & $git -C $root log --oneline -1
Write-Host "Viedään versio: $version"

$archive = Join-Path $env:TEMP "kotilo-release.tar.gz"
& $git -C $root archive --format=tar.gz -o $archive HEAD
if ($LASTEXITCODE -ne 0) { throw "Paketin luonti epäonnistui." }

& ssh $Server "mkdir -p /opt/kotilo"
if ($LASTEXITCODE -ne 0) { throw "SSH-yhteys palvelimeen $Server epäonnistui." }
& scp $archive "${Server}:/opt/kotilo/release.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "Paketin siirto palvelimelle epäonnistui." }
Remove-Item $archive

# Uusi versio puretaan viereen ja vaihdetaan paikalleen kerralla. Tietokanta ja asetukset ovat muualla.
$remote = "set -e; cd /opt/kotilo; rm -rf app.new; mkdir app.new; tar -xzf release.tar.gz -C app.new; rm -rf app.old; if [ -d app ]; then mv app app.old; fi; mv app.new app; rm -f release.tar.gz; bash app/deploy/server/remote-deploy.sh"
& ssh $Server $remote
if ($LASTEXITCODE -ne 0) { throw "Asennus palvelimella epäonnistui. Katso virhe yltä." }

Write-Host ""
Write-Host "Valmis. Alusta: https://app.kotilo.io  Esittelysivu: https://kotilo.io"
