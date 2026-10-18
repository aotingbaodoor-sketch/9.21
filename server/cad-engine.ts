import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { rasterOriginal } from "./drawing-raster.ts";
import { HttpError } from "./domain.ts";
let active = 0;
export async function cadWorker(action: string, data: unknown): Promise<any> {
  if (active >= 1)
    throw new HttpError(503, "CAD处理队列繁忙，请稍后重试；原文件保留");
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.CAD_PYTHON || "python3",
        [fileURLToPath(new URL("./cad/worker.py", import.meta.url))],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, WINDIR:process.env.WINDIR, TEMP:process.env.TEMP,TMP:process.env.TMP,LANG:'C.UTF-8',PYTHONIOENCODING:'utf-8' },
        },
      );
      let text = "",
        size = 0,
        done = false;
      const finish = (error?: Error, value?: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new HttpError(422, "CAD分析超时，请拆分复杂图纸后重试"));
      }, 30000);
      child.on("error", () =>
        finish(
          new HttpError(
            503,
            "CAD运行组件未就绪，请管理员检查服务端Python与ezdxf安装",
          ),
        ),
      );
      child.stdout.on("data", (b) => {
        size += b.length;
        if (size > 16 * 1024 * 1024) {
          child.kill();
          finish(new HttpError(422, "CAD分析结果过大，请分图上传"));
        } else text += b.toString();
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("close", (code) => {
        try {
          const result = JSON.parse(text);
          if (code || result.error)
            finish(
              new HttpError(
                422,
                "CAD解析失败，请检查文件完整性或另存UTF-8 ASCII DXF",
              ),
            );
          else finish(undefined, result);
        } catch {
          finish(new HttpError(422, "CAD组件未返回有效结果"));
        }
      });
      child.stdin.end(JSON.stringify({ action, data }));
    });
  } finally {
    active--;
  }
}
export async function analyzeCad(bytes: Buffer, format: string): Promise<any> {
  if (format === "dwg")
    return {
      status: "unsupported",
      format,
      warnings: [
        "DWG原件已保留。本服务器未安装已授权DWG转换器；请从原CAD软件另存DXF后上传，不会改扩展名伪装转换。",
      ],
    };
  if (format === "dxf") return cadWorker("analyze", bytes.toString("base64"));
  const mime =
    format === "pdf"
      ? "application/pdf"
      : format === "png"
        ? "image/png"
        : "image/jpeg";
  const pages = await rasterOriginal(bytes, mime);
  const dir = await mkdtemp(path.join(os.tmpdir(), "autinberg-cad-"));
  const evidence: any[] = [];
  const warnings = [
    "图像/OCR结果仅供人工核对，未从像素推算生产尺寸；请确认单位和比例",
  ];
  try {
    for (const [page, p] of pages.entries()) {
      const input = path.join(dir, `page-${page}.png`);
      await writeFile(input, Buffer.from(p.png, "base64"), { mode: 0o600 });
      try {
        const { stdout } = await promisify(execFile)(
          "tesseract",
          [input, "stdout", "-l", "eng+chi_sim", "tsv"],
          { timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
        );
        for (const line of stdout.split(/\r?\n/).slice(1)) {
          const c = line.split("\t");
          if (c.length >= 12 && c[11].trim())
            evidence.push({
              page: page + 1,
              text: c.slice(11).join("\t"),
              confidence: Number(c[10]),
              region: [
                Number(c[6]) / p.width,
                Number(c[7]) / p.height,
                Number(c[8]) / p.width,
                Number(c[9]) / p.height,
              ],
              status: "待确认",
            });
        }
      } catch {
        warnings.push(`第${page + 1}页OCR未完成，可查看原图手动录入并重试`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    status: evidence.length ? "analyzed" : "manual",
    format,
    pages,
    evidence,
    warnings,
    units: 0,
  };
}
