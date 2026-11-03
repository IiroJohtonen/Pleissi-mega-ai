// Valmiiksi tunnetut viranomaisten domainit (sender-types.ts). Lisätään toimiston listalle kerran, kun lista otetaan
// käyttöön; pääkäyttäjä voi poistaa tai lisätä niitä asetuksista. Myös aliverkkotunnukset tunnistetaan.
// Paikalliset viranomaiset (kunnan rakennusvalvonta, hyvinvointialueen pelastuslaitos) toimisto lisää itse.
export const DEFAULT_SENDER_DOMAINS = [
  "poliisi.fi", // Poliisi
  "pelastuslaitokset.fi", // Pelastuslaitosten yhteinen palvelu
  "vero.fi", // Verohallinto
  "kela.fi", // Kansaneläkelaitos
  "dvv.fi", // Digi- ja väestötietovirasto
  "prh.fi", // Patentti- ja rekisterihallitus (kaupparekisteri, taloyhtiöt)
  "maanmittauslaitos.fi", // Maanmittauslaitos (huoneistotietojärjestelmä)
  "nls.fi", // Maanmittauslaitos
  "ulosottolaitos.fi", // Ulosottolaitos
  "oikeus.fi", // Tuomioistuimet
  "tukes.fi", // Turvallisuus- ja kemikaalivirasto
  "traficom.fi", // Liikenne- ja viestintävirasto
  "stuk.fi", // Säteilyturvakeskus (radon)
  "varke.fi", // Valtion tukeman asuntorakentamisen keskus (ent. ARA)
  "ara.fi", // ARA (vanha osoite)
  "ym.fi", // Ympäristöministeriö
  "ely-keskus.fi", // ELY-keskukset
  "elinvoimakeskus.fi", // Elinvoimakeskukset
  "avi.fi", // Aluehallintovirastot (vanha osoite)
  "luvi.fi", // Lupa- ja valvontavirasto
  "tulli.fi", // Tulli
  "suomi.fi" // Suomi.fi-viestit
].map(domain => ({ domain, type: "authority" as const }));
