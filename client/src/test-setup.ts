// Testien selainympäristö (jsdom) ei vieritä eikä tunne scrollIntoView-funktiota. Ilman tätä osioon
// siirtyminen (esim. asetusten aliotsikosta) kaatuu, jos vieritys ehtii käynnistyä ennen testin loppua.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
