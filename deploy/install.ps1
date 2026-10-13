# Asentaa Kotilon tuotantokopion omaan kansioonsa, erilleen kehitysversiosta ja sen tietokannasta.
# Aja kehitysrepon juuresta:  powershell -ExecutionPolicy Bypass -File deploy\install.ps1
param(
  # Kansio, johon tuotantokopio tulee.
  [string]$Target = (Join-Path $env:USERPROFILE "kotilo-tuotanto"),
  # Osoite, josta alusta avataan selaimessa.
  [string]$AppUrl = "https://app.kotilo.io",
  # Portti, jota tuotantopalvelin kuuntelee tällä koneella. Kehitysversio käyttää porttia 4000.
  [int]$Port = 4100
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $PSScriptRoot
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "C:\Program Files\Git\cmd\git.exe" }
if (-not (Test-Path $git)) { throw "Git ei löytynyt. Asenna Git tai lisää se PATH-muuttujaan." }

if (Test-Path (Join-Path $Target ".git")) {
  Write-Host "Tuotantokopio on jo kansiossa $Target. Päivitä se komennolla deploy\update.ps1."
} else {
  if ((Test-Path $Target) -and (Get-ChildItem $Target -Force | Select-Object -First 1)) {
    throw "Kansio $Target on olemassa eikä ole tyhjä. Valitse toinen kansio parametrilla -Target."
  }
  Write-Host "Kloonataan $source -> $Target"
  & $git clone --quiet $source $Target
  if ($LASTEXITCODE -ne 0) { throw "Kloonaus epäonnistui." }
}

# Tuotannon asetukset. AI-avain ja malli kopioidaan kehitysversion asetuksista, jos ne on asetettu.
$envPath = Join-Path $Target "server\.env"
if (Test-Path $envPath) {
  Write-Host "Asetustiedosto $envPath on jo olemassa, sitä ei muuteta."
} else {
  $carried = @()
  $devEnv = Join-Path $source "server\.env"
  if (Test-Path $devEnv) {
    $carried = Get-Content $devEnv -Encoding UTF8 | Where-Object { $_ -match '^(ANTHROPIC_API_KEY|ANTHROPIC_MODEL)=.+' }
  }
  $dataDir = Join-Path $Target "data"
  $backupDir = Join-Path $Target "varmuuskopiot"
  $lines = @(
    "# Kotilon tuotantoasetukset. Tämä tiedosto sisältää salaisuuksia eikä kuulu repoon.",
    "PORT=$Port",
    "APP_URL=$AppUrl",
    "# Cloudflare Tunnel on palvelimen edessä yhtenä välityspalvelimena.",
    "TRUST_PROXY=1",
    "DATA_DIR=$dataDir",
    "# Varmuuskopio otetaan kerran päivässä. Kopioi kansio säännöllisesti myös toiselle levylle.",
    "BACKUP_DIR=$backupDir",
    "BACKUP_KEEP=14",
    "DEFAULT_COMPANY_ID=demo-company",
    "AUTHORIZED_COMPANY_IDS=demo-company",
    "# Googlen kirjautuminen palaa tähän osoitteeseen. Lisää sama osoite Google Cloud -konsoliin.",
    "GMAIL_REDIRECT_URI=$AppUrl/api/gmail/callback",
    "# Tyhjänä ensimmäisten käyttäjien salasana arvotaan ja tulostetaan lokiin (logs\kotilo.log).",
    "INITIAL_PASSWORD="
  ) + $carried
  New-Item -ItemType Directory -Force $dataDir, $backupDir | Out-Null
  [IO.File]::WriteAllLines($envPath, $lines, (New-Object Text.UTF8Encoding $false))
  Write-Host "Luotiin $envPath"
}

# Gmailin OAuth-clientin tiedot ovat samat kuin kehitysversiossa; kirjautumistunnistetta ei kopioida,
# koska tili yhdistetään tuotannossa uudelleen sovelluksen asetuksista.
$credentials = Join-Path $source "server\credentials.json"
$targetCredentials = Join-Path $Target "server\credentials.json"
if ((Test-Path $credentials) -and -not (Test-Path $targetCredentials)) {
  Copy-Item $credentials $targetCredentials
  Write-Host "Kopioitiin Gmailin OAuth-clientin tiedot."
}

& (Join-Path $Target "deploy\build.ps1") -Root $Target

Write-Host ""
Write-Host "Valmis. Seuraavaksi:"
Write-Host "  1. Käynnistä:            powershell -ExecutionPolicy Bypass -File `"$Target\deploy\start.ps1`""
Write-Host "  2. Kokeile selaimessa:   http://localhost:$Port"
Write-Host "  3. Aloitussalasana:      $Target\logs\kotilo.log"
Write-Host "  4. Loput vaiheet (Cloudflare, automaattinen käynnistys): deploy\README.md"
