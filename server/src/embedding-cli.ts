import "dotenv/config";
import { embeddingKilled, embeddingModel, rebuildEmbeddings } from "./embedding.js";

// Laskee kaikki merkityshaun vektorit uudelleen, esimerkiksi mallin vaihdon jälkeen:
//   npm run embeddings:rebuild
// Vektorit lasketaan niille lähteille, joilla merkityshaku on asetuksissa käytössä. Aja palvelimen ollessa
// pysähdyksissä tai hiljaisena aikana: laskenta kuormittaa prosessoria.
if (embeddingKilled()) {
  console.error("Merkityshaku on kytketty pois (EMBEDDING_ENABLED=false).");
  process.exit(1);
}
console.log(`Lasketaan vektorit uudelleen mallilla ${embeddingModel()}…`);
const started = Date.now();
rebuildEmbeddings()
  .then(result => {
    console.log(`Valmis: ${result.embedded} vektoria, ${Math.round((Date.now() - started) / 1000)} s.`);
  })
  .catch(error => {
    console.error("Uudelleenlaskenta epäonnistui:", error?.message ?? error);
    process.exit(1);
  });
