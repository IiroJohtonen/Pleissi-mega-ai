import path from "node:path";

export class UnsupportedDocumentError extends Error {}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);

// Lukee dokumentin tekstin: PDF, Word (.docx), kuva (tekstintunnistus) tai tekstitiedosto.
export async function extractText(
  content: Buffer,
  fileName: string,
  mimeType: string
): Promise<string> {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".pdf" || mimeType === "application/pdf") {
    const { extractText: extractPdfText } = await import("unpdf");
    const { text } = await extractPdfText(new Uint8Array(content), { mergePages: true });
    return text.trim();
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
