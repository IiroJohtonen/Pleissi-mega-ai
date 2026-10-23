# Vie Pleissi Mega AI:n nykyisen version palvelimelle ja käynnistää sen. Sama komento asentaa ensimmäisellä
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

$archive = Join-Path $env:TEMP "pleissi-ai-release.tar.gz"
& $git -C $root archive --format=tar.gz -o $archive HEAD
if ($LASTEXITCODE -ne 0) { throw "Paketin luonti epäonnistui." }

# Mega AI on Kotilon kopio, ja molemmat tarvitsevat palvelimen portit 80 ja 443. Kotilon tuotantopalvelimelle
# ei asenneta, jotta tuotanto ei pysähdy eikä sen tietoja käytetä vahingossa.
& ssh $Server "test ! -d /opt/kotilo"
if ($LASTEXITCODE -eq 255) { throw "SSH-yhteys palvelimeen $Server epäonnistui." }
if ($LASTEXITCODE -ne 0) { throw "Palvelimella $Server on Kotilon tuotantoversio (/opt/kotilo). Pleissi Mega AI asennetaan omalle palvelimelleen." }

& ssh $Server "mkdir -p /opt/pleissi-ai"
if ($LASTEXITCODE -ne 0) { throw "SSH-yhteys palvelimeen $Server epäonnistui." }
& scp $archive "${Server}:/opt/pleissi-ai/release.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "Paketin siirto palvelimelle epäonnistui." }
Remove-Item $archive

# Uusi versio puretaan viereen ja vaihdetaan paikalleen kerralla. Tietokanta ja asetukset ovat muualla.
$remote = "set -e; cd /opt/pleissi-ai; rm -rf app.new; mkdir app.new; tar -xzf release.tar.gz -C app.new; rm -rf app.old; if [ -d app ]; then mv app app.old; fi; mv app.new app; rm -f release.tar.gz; bash app/deploy/server/remote-deploy.sh"
& ssh $Server $remote
if ($LASTEXITCODE -ne 0) { throw "Asennus palvelimella epäonnistui. Katso virhe yltä." }

Write-Host ""
Write-Host "Valmis. Alusta: https://test2.kotilo.io"
