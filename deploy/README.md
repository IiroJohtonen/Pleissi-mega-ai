# Kotilon julkaisu osoitteeseen kotilo.io

> **Palvelimelle (suositus):** jos käytössä on palvelin, esimerkiksi UpCloud, seuraa ohjetta [server/README.md](server/README.md). Tämä tiedosto kuvaa vaihtoehdon, jossa alusta pyörii omalla koneella.

Rakenne on kaksiosainen, jotta esittelysivua ja alustaa voi kehittää erikseen:

| Osoite | Sisältö | Missä pyörii |
| --- | --- | --- |
| `kotilo.io` | Esittelysivu (kansio `site/`) | Cloudflare Pages |
| `app.kotilo.io` | Alusta | Tuotantokopio tällä koneella, Cloudflare Tunnelin takana |

Esittelysivu pysyy pystyssä, vaikka kone olisi kiinni. Alusta toimii vain, kun kone on päällä ja Kotilo käynnissä.

Kotikone sopii esittelyyn ja omaan testaukseen. Ennen kuin alustalla käsitellään oikean asiakkaan asukastietoja, siirrä tuotantokopio palvelimelle: kopioi kansio `data` ja käytä samaa `server/.env`-tiedostoa.

## 1. Tuotantokopio tälle koneelle

Tuotantokopio on oma kansionsa ja oma tietokantansa. Kehitysversion muutokset eivät näy kävijöille ennen kuin päivität kopion.

```powershell
# Kehitysrepon juuressa:
powershell -ExecutionPolicy Bypass -File deploy\install.ps1
```

Komento kloonaa repon kansioon `%USERPROFILE%\kotilo-tuotanto`, luo asetustiedoston `server\.env`, asentaa riippuvuudet ja kääntää sovelluksen. Sen jälkeen:

```powershell
cd $env:USERPROFILE\kotilo-tuotanto
powershell -ExecutionPolicy Bypass -File deploy\start.ps1
```

Avaa `http://localhost:4100`. Tietokanta on uusi, joten kirjaudu osoitteella `demo@pohjantahti-isannointi.fi`. Aloitussalasana on lokissa `logs\kotilo.log`. Vaihda käyttäjien osoitteet ja salasanat heti asetuksista.

Kun kaikki toimii, aseta Kotilo käynnistymään itsestään:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\autostart.ps1
```

Estä myös koneen nukahtaminen virta-asetuksista, muuten alusta katoaa näkyvistä, kun kone menee lepotilaan.

## 2. Domain Cloudflareen

1. Luo tili osoitteessa cloudflare.com ja lisää sivusto `kotilo.io` (ilmainen taso riittää).
2. Cloudflare näyttää kaksi nimipalvelinta. Vaihda ne domainin ostopaikan hallintapaneelista domainin nimipalvelimiksi.
3. Odota, että Cloudflare merkitsee sivuston aktiiviseksi. Tämä kestää yleensä alle tunnin.

## 3. Alusta: Cloudflare Tunnel

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create kotilo
cloudflared tunnel route dns kotilo app.kotilo.io
```

Kopioi `deploy\cloudflared.example.yml` nimelle `%USERPROFILE%\.cloudflared\config.yml` ja täydennä siihen tunnelin tunniste. Kokeile ensin käsin ja asenna sitten palveluksi, joka käynnistyy koneen mukana:

```powershell
cloudflared tunnel run kotilo        # kokeilu: avaa https://app.kotilo.io
cloudflared service install          # pysyvä käyttö
```

## 4. Esittelysivu: Cloudflare Pages

1. Cloudflaren hallinnassa: **Workers & Pages → Create → Pages → Upload assets**.
2. Anna projektin nimeksi `kotilo` ja lataa kansion `site` sisältö.
3. Projektin **Custom domains** -välilehdellä lisää `kotilo.io` (ja halutessasi `www.kotilo.io`).

Kun muutat sivua, lataa kansio uudelleen samaan projektiin. Sivulla on yhteysosoite `hei@kotilo.io`: varmista, että osoite on olemassa, tai vaihda se tiedostosta `site/index.html`.

## 5. Gmail tuotannossa

Googlen kirjautuminen on sidottu osoitteeseen, joten tuotanto tarvitsee oman paluuosoitteensa:

1. Google Cloud -konsolissa OAuth-clientin **Authorized redirect URIs** -listaan lisätään `https://app.kotilo.io/api/gmail/callback`.
2. Yhdistä Gmail-tili tuotannossa uudelleen: Asetukset → Isännöitsijätoimiston tiedot → Toimiston Gmail-tili.
3. Aseta kehitysversion tiedostoon `server\.env` rivi `GMAIL_DISABLED=1`. Muuten kehitys- ja tuotantoversio lukevat samaa postilaatikkoa, ja sama viesti päätyy kumpaankin.

## Päivittäminen

Kun kehitysversiossa on uusi versio valmiina:

```powershell
cd $env:USERPROFILE\kotilo-tuotanto
powershell -ExecutionPolicy Bypass -File deploy\update.ps1
```

Komento hakee muutokset, kääntää sovelluksen ja pysäyttää vanhan palvelimen. `start.ps1` käynnistää uuden version itse muutamassa sekunnissa.

## Varmuuskopiot

Tuotantokopio ottaa varmuuskopion kerran päivässä kansioon `varmuuskopiot` ja säilyttää 14 uusinta. Kopiot ovat samalla levyllä kuin tietokanta, joten kopioi kansio säännöllisesti myös toiselle levylle tai pilvipalveluun.
