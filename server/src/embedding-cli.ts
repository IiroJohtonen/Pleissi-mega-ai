import "dotenv/config";
import { downloadModel, embeddingKilled, embeddingModelKey, rebuildEmbeddings } from "./embedding.js";

// Merkityshaun ylläpitokomennot:
//   npm run embeddings:download   lataa mallin (lukittu versio) kansioon EMBEDDING_MODEL_DIR. Tuotannossa
//                                 ensin tämä, sitten EMBEDDING_ALLOW_DOWNLOAD=false, jottei ajon aikana ladata.
//   npm run embeddings:rebuild    laskee kaikki vektorit uudelleen, esimerkiksi mallin vaihdon jälkeen.
// Tuotannon kontissa: node dist/embedding-cli.js download | rebuild.
// Vektorit lasketaan niille lähteille, joilla merkityshaku on asetuksissa käytössä. Uudelleenlaskenta
// kuormittaa prosessoria, joten aja se hiljaisena aikana.
const command = process.argv[2] ?? "rebuild";
const started = Date.now();
const seconds = () => Math.round((Date.now() - started) / 1000);

if (command === "download") {
  console.log(`Ladataan malli ${embeddingModelKey()}…`);
  downloadModel()
    .then(result => console.log(`Valmis: malli on kansiossa ${result.dir} (${result.dimensions} ulottuvuutta, ${seconds()} s).`))
    .catch(error => {
      console.error("Mallin lataus epäonnistui:", error?.message ?? error);
      process.exit(1);
    });
} else if (command === "rebuild") {
  if (embeddingKilled()) {
    console.error("Merkityshaku on kytketty pois (EMBEDDING_ENABLED=false).");
    process.exit(1);
  }
  console.log(`Lasketaan vektorit uudelleen mallilla ${embeddingModelKey()}…`);
  rebuildEmbeddings()
    .then(result => console.log(`Valmis: ${result.embedded} vektoria, ${seconds()} s.`))
    .catch(error => {
      console.error("Uudelleenlaskenta epäonnistui:", error?.message ?? error);
      process.exit(1);
    });
} else {
  console.error(`Tuntematon komento "${command}". Käytössä: download, rebuild.`);
  process.exit(1);
}
