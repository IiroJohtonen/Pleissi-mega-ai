import path from "node:path";
import { htmlToMarkdown, plainToMarkdown } from "./rich-text.js";

export class UnsupportedDocumentError extends Error {}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);

export function isPdf(fileName: string, mimeType: string) {
  return path.extname(fileName).toLowerCase() === ".pdf" || mimeType === "application/pdf";
}

// Lukee dokumentin tekstin sivuittain. PDF palauttaa jokaisen sivun omana alkionaan, jotta tiedon
// sivunumero säilyy; muut muodot ovat yksi sivu.
export async function extractPages(
  content: Buffer,
  fileName: string,
  mimeType: string
): Promise<string[]> {
  if (isPdf(fileName, mimeType)) {
    const { extractText: extractPdfText } = await import("unpdf");
    const { text } = await extractPdfText(new Uint8Array(content), { mergePages: false });
    return text.map(page => page.trim());
  }
  return [await extractText(content, fileName, mimeType)];
}

// Dokumentin muotoiltu teksti. Wordin otsikot, lihavoinnit ja luettelot säilyvät sellaisinaan; muista
// muodoista muotoilu päätellään luetusta tekstistä (otsikkorivit, luettelot, kappaleet).
export async function extractFormatted(content: Buffer, fileName: string, text: string): Promise<string> {
  if (path.extname(fileName).toLowerCase() === ".docx") {
    try {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.convertToHtml({ buffer: content }, { styleMap: ["u => u"] });
      const formatted = htmlToMarkdown(value);
      if (formatted) return formatted;
    } catch {
      // Muotoilun lukeminen ei saa estää tallennusta: käytetään luettua tekstiä.
    }
  }
  return plainToMarkdown(text);
}

// Lukee dokumentin tekstin: PDF, Word (.docx), kuva (tekstintunnistus) tai tekstitiedosto.
export async function extractText(
  content: Buffer,
  fileName: string,
  mimeType: string
): Promise<string> {
  const extension = path.extname(fileName).toLowerCase();

  if (isPdf(fileName, mimeType)) {
    return (await extractPages(content, fileName, mimeType)).filter(Boolean).join("\n\n");
  }

  if (extension === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: content });
    return value.trim();
  }

  if (extension === ".doc") {
    throw new UnsupportedDocumentError(
      "Vanhaa .doc-muotoa ei tueta. Tallenna dokumentti .docx- tai PDF-muodossa."
    );
  }

  if (IMAGE_EXTENSIONS.has(extension) || mimeType.startsWith("image/")) {
    const { createWorker } = await import("tesseract.js");
    // Kielimalli ladataan ensimmäisellä kerralla verkosta ja tallennetaan data-kansioon.
    const worker = await createWorker("fin", 1, {
      cachePath: path.resolve(process.cwd(), "data")
    });
    try {
      const { data } = await worker.recognize(content);
      return data.text.trim();
    } finally {
      await worker.terminate();
    }
  }

  if (extension === ".txt" || mimeType.startsWith("text/")) {
    return content.toString("utf8").trim();
  }

  throw new UnsupportedDocumentError("Tuettuja tiedostoja ovat PDF, Word (.docx) ja kuvat.");
}

// PDF:n sivumäärä ja jako eriin AI:lle: jokainen erä on oma PDF, jossa on enintään pagesPerBatch sivua.
// firstPage on erän ensimmäisen sivun numero alkuperäisessä dokumentissa.
export type PdfBatch = { firstPage: number; lastPage: number; data: Buffer };
export async function pdfBatches(content: Buffer, pagesPerBatch: number): Promise<PdfBatch[]> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(content, { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  if (pageCount <= pagesPerBatch) return [{ firstPage: 1, lastPage: pageCount, data: content }];
  const batches: PdfBatch[] = [];
  for (let start = 0; start < pageCount; start += pagesPerBatch) {
    const indices = Array.from({ length: Math.min(pagesPerBatch, pageCount - start) }, (_, index) => start + index);
    const part = await PDFDocument.create();
    for (const page of await part.copyPages(source, indices)) part.addPage(page);
    batches.push({ firstPage: start + 1, lastPage: start + indices.length, data: Buffer.from(await part.save()) });
  }
  return batches;
}
