import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { lineSchema } from "../../shared/quoting.ts";
import { HttpError } from "../domain.ts";
export async function importLines(bytes: Buffer, products: { id: string; sku: string; data: { standardSpecs?: Record<string, string> } }[]) {
  if (bytes.length > 2e6 || bytes.length < 46 || bytes.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, "请选择2MB以内的 .xlsx 文件");
  let unpacked = 0, entries = 0;
  for (let i = 0; i <= bytes.length - 46; i++) if (bytes.readUInt32LE(i) === 0x02014b50) {
    const size = bytes.readUInt32LE(i + 24); unpacked += size; entries++;
    if (size === 0xffffffff || unpacked > 20e6 || entries > 100 || (bytes.readUInt16LE(i + 8) & 1)) throw new HttpError(400, "压缩文件过大、加密或格式不受支持");
    i += 45 + bytes.readUInt16LE(i + 28) + bytes.readUInt16LE(i + 30) + bytes.readUInt16LE(i + 32);
  }
  if (!entries) throw new HttpError(400, "Excel压缩目录无效");
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]); } catch { throw new HttpError(400, "无法读取Excel文件"); }
  const sheet = book.getWorksheet("Products") || book.worksheets[0];
  if (!sheet || sheet.rowCount > 101 || sheet.columnCount > 30) throw new HttpError(400, "最多100行产品、30列");
  const headers = ["SKU", "Width", "Height", "Unit", "Quantity", "Location", "Columns", "Rows", "Panels", "Swing", "Special", "Notes"];
  if (headers.some((v, i) => sheet.getRow(1).getCell(i + 1).value !== v)) throw new HttpError(400, `首行表头必须是：${headers.join(", ")}`);
  const lines = [], errors: string[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r), cells = headers.map((_, i) => row.getCell(i + 1).value);
    if (cells.every(v => v === null || v === "")) continue;
    if (cells.some(v => typeof v === "object" && v !== null)) { errors.push(`第${r}行仅支持文本和数字，不支持公式/富文本/超链接`); continue; }
    const p = products.find(p => p.sku === String(cells[0] || "").trim());
    if (!p) { errors.push(`第${r}行SKU不存在或已停用`); continue; }
    const v = lineSchema.safeParse({ key: randomUUID(), productId: p.id, width: Number(cells[1]), height: Number(cells[2]), unit: cells[3] || "mm", quantity: Number(cells[4]), location: String(cells[5] || ""), columns: Number(cells[6] || 2), rows: Number(cells[7] || 1), panels: String(cells[8] || "fixed,right").split(",").map(v => v.trim()), swing: cells[9] || "in", special: String(cells[10] || ""), notes: String(cells[11] || ""), specs: p.data.standardSpecs || {} });
    if (v.success) lines.push(v.data); else errors.push(`第${r}行：${v.error.issues.map(i => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  return { lines, errors, total: lines.length + errors.length };
}
