# Tyhjentää palvelimen alustan ja luo tilalle esittelyaineiston (taloyhtiöt, asukkaat, tehtävät, avaimet,
# vuorot, dokumentit ym.). Ennen tyhjennystä otetaan varmuuskopio kansioon /opt/pleissi-ai/varmuuskopiot.
# Kaikki nykyiset tiedot ja käyttäjät poistuvat. Toimiston asetukset säilyvät.
# Aja kehitysrepon juuresta sen jälkeen, kun uusin versio on viety palvelimelle (deploy.ps1):
#   powershell -ExecutionPolicy Bypass -File deploy\server\demo-reset.ps1 -Server root@test2.kotilo.io -Salasana "Esittely-2026" -Sahkoposti oma@osoite.fi
param(
  # SSH-osoite, esim. root@test2.kotilo.io
  [Parameter(Mandatory = $true)][string]$Server,
  # Kaikkien esittelytunnusten salasana (vähintään 8 merkkiä).
  [Parameter(Mandatory = $true)][string]$Salasana,
  # Pääkäyttäjän kirjautumissähköposti. Anna oma osoitteesi, jos kirjautumiskoodi on käytössä.
  [string]$Sahkoposti = ""
)

$ErrorActionPreference = "Stop"
if ($Salasana.Length -lt 8) { throw "Salasanassa pitää olla vähintään 8 merkkiä." }
if ($Salasana -match "'" -or $Sahkoposti -match "'") { throw "Salasanassa tai sähköpostissa ei saa olla heittomerkkiä (')." }

Write-Host "Tämä poistaa KAIKKI alustan tiedot palvelimelta $Server ja luo esittelyaineiston."
Write-Host "Nykyiset tehtävät, taloyhtiöt, asukkaat, käyttäjät, dokumentit ja liitteet poistuvat. Varmuuskopio otetaan ensin."
$answer = Read-Host "Kirjoita POISTA jatkaaksesi"
if ($answer -ne "POISTA") { Write-Host "Peruttu. Mitään ei muutettu."; exit 1 }

$resetArgs = "--vahvista --salasana='$Salasana'"
if ($Sahkoposti) { $resetArgs += " --sahkoposti='$Sahkoposti'" }
# Sovellus pysäytetään ajon ajaksi ja käynnistetään lopuksi uudelleen, vaikka ajo epäonnistuisi.
$remote = "cd /opt/pleissi-ai/app/deploy/server && C='docker compose -p pleissi-ai -f docker-compose.yml'; `$C stop kotilo; `$C run --rm --no-deps kotilo node dist/demo-reset.js $resetArgs; status=`$?; `$C up -d kotilo; exit `$status"
& ssh $Server $remote
if ($LASTEXITCODE -ne 0) { throw "Esittelyaineiston luonti epäonnistui. Alusta käynnistettiin uudelleen ennallaan; katso virhe yltä." }

Write-Host ""
Write-Host "Valmis. Kirjaudu: https://test2.kotilo.io"
