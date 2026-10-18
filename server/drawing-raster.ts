import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpError } from "./domain.ts";
export type RasterPage = { width: number; height: number; png: string };
export type Mask = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
const run = promisify(execFile);
let active = 0;
async function png(bytes: Buffer): Promise<RasterPage> {
  const { data, info } = await sharp(bytes, {
    limitInputPixels: 24000000,
    failOn: "warning",
  })
    .rotate()
    .flatten({ background: "#fff" })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    png: data.toString("base64"),
  };
}
export async function rasterOriginal(
  bytes: Buffer,
  mime: string,
): Promise<RasterPage[]> {
  if (active >= 2) throw new HttpError(503, "图纸转换繁忙，请稍后重试");
  if (bytes.length > 4 * 1024 * 1024)
    throw new HttpError(413, "原图上限4MB，PDF最多5页");
  active++;
  let dir = "";
  try {
    let pages: RasterPage[];
    if (mime === "application/pdf") {
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw new Error("format");
      const pdf = await PDFDocument.load(bytes);
      if (pdf.getPageCount() < 1 || pdf.getPageCount() > 5)
        throw new HttpError(422, "PDF须为1—5页，请按图纸分卷上传");
      dir = await mkdtemp(path.join(os.tmpdir(), "autinberg-drawing-"));
      await writeFile(path.join(dir, "original.pdf"), bytes, { mode: 0o600 });
      await run(
        "pdftoppm",
        [
          "-png",
          "-r",
          "180",
          "-scale-to",
          "4200",
          "-f",
          "1",
          "-l",
          "5",
          path.join(dir, "original.pdf"),
          path.join(dir, "page"),
        ],
        { timeout: 25000, maxBuffer: 128 * 1024, windowsHide: true },
      );
      const files = (await readdir(dir))
        .filter((f) => /^page-\d+\.png$/.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (files.length !== pdf.getPageCount()) throw new Error("pages");
      pages = [];
      for (const file of files)
        pages.push(await png(await readFile(path.join(dir, file))));
    } else {
      const meta = await sharp(bytes, {
        limitInputPixels: 24000000,
      }).metadata();
      if (
        !["png", "jpeg"].includes(meta.format ?? "") ||
        (meta.pages ?? 1) !== 1
      )
        throw new Error("format");
      pages = [await png(bytes)];
    }
    if (pages.reduce((n, p) => n + p.png.length, 0) > 24 * 1024 * 1024)
      throw new HttpError(
        413,
        "图纸展开后过大，请拆分上传，避免降低尺寸标注清晰度",
      );
    return pages;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      422,
      "图纸转换失败：仅支持可读取的PDF/PNG/JPEG；加密或损坏文件请另存后上传",
    );
  } finally {
    active--;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
export async function redactPages(
  pages: RasterPage[],
  masks: Mask[],
): Promise<RasterPage[]> {
  return Promise.all(
    pages.map(async (p, index) => {
      const rects = masks
        .filter((m) => m.page === index)
        .map(
          (m) =>
            `<rect x="${Math.floor(m.x * p.width)}" y="${Math.floor(m.y * p.height)}" width="${Math.ceil(m.width * p.width) + 1}" height="${Math.ceil(m.height * p.height) + 1}" fill="black"/>`,
        )
        .join("");
      const bytes = Buffer.from(p.png, "base64");
      // Burn masks into fresh pixels. No original PDF text, annotations, metadata or reversible overlay survives.
      const rendered = rects
        ? await sharp(bytes)
            .composite([
              {
                input: Buffer.from(
                  `<svg width="${p.width}" height="${p.height}">${rects}</svg>`,
                ),
              },
            ])
            .png()
            .toBuffer()
        : await sharp(bytes).png().toBuffer();
      return {
        width: p.width,
        height: p.height,
        png: rendered.toString("base64"),
      };
    }),
  );
}
export async function rasterPdf(pages: RasterPage[], base?: Buffer) {
  const pdf = base ? await PDFDocument.load(base) : await PDFDocument.create();
  for (const p of pages) {
    const img = await pdf.embedPng(Buffer.from(p.png, "base64"));
    const page = pdf.addPage([(p.width * 72) / 180, (p.height * 72) / 180]);
    page.drawImage(img, {
      x: 0,
      y: 0,
      width: page.getWidth(),
      height: page.getHeight(),
    });
  }
  return Buffer.from(await pdf.save());
}
