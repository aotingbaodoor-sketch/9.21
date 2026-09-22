import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";

const output = new URL("../public/templates/quotation-lines.xlsx", import.meta.url);
const workbook = new ExcelJS.Workbook();
workbook.creator = "AUTINBERG CRM";
workbook.created = new Date("2026-01-01T00:00:00Z");

const sheet = workbook.addWorksheet("Products", {
  views: [{ state: "frozen", ySplit: 1 }],
});
const headers = ["SKU", "Width", "Height", "Unit", "Quantity", "Location", "Columns", "Rows", "Panels", "Swing", "Special", "Notes"];
sheet.addRow(headers);
sheet.columns = [18, 12, 12, 10, 10, 18, 10, 10, 24, 12, 28, 28].map(width => ({ width }));
sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF9A7A3E" } };
sheet.autoFilter = { from: "A1", to: "L1" };
for (let row = 2; row <= 101; row++) {
  sheet.getCell(`D${row}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"mm,cm,m"'] };
  sheet.getCell(`J${row}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"in,out"'] };
}

await workbook.xlsx.writeFile(fileURLToPath(output));
