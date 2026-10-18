import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
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
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            LANG: "C.UTF-8",
            PYTHONIOENCODING: "utf-8",
          },
        },
      );
      let text = "",
        size = 0,
        done = false;
      const finish = (error?: Error, value?: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
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
                typeof result.error === "string" &&
                  result.error.startsWith("生产图：")
                  ? result.error
                  : "图纸解析失败：请检查文件是否加密/损坏；PDF上限30页，复杂CAD请分图上传。原件保留，可重试。",
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
export async function analyzeCad(
  bytes: Buffer,
  format: string,
  progress: (phase: string) => Promise<void> = async () => {},
): Promise<any> {
  await progress(
    format === "dwg"
      ? "转换DWG"
      : format === "pdf"
        ? "提取PDF原生文字及矢量"
        : "解析原图",
  );
  if (format === "dwg") {
    const dir = await mkdtemp(path.join(os.tmpdir(), "autinberg-dwg-"));
    try {
      await writeFile(path.join(dir, "original.dwg"), bytes, { mode: 0o600 });
      try {
        await promisify(execFile)(
          process.env.CAD_DWG_CONVERTER || "dwg2dxf",
          [
            "-v0",
            "-o",
            path.join(dir, "converted.dxf"),
            path.join(dir, "original.dwg"),
          ],
          {
            cwd: dir,
            timeout: 20000,
            maxBuffer: 128 * 1024,
            windowsHide: true,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              TEMP: dir,
              TMP: dir,
            },
          },
        );
      } catch (e: any) {
        if (e.code === "ENOENT")
          return {
            status: "unsupported",
            format,
            warnings: [
              "DWG转换器未安装；请管理员检查LibreDWG部署，或从原CAD软件另存DXF。原件已保留。",
            ],
          };
        throw new HttpError(
          422,
          "DWG转换失败或包含不支持对象；请用原CAD软件另存DXF后重试。未把不完整转换标为成功。",
        );
      }
      if ((await stat(path.join(dir, "converted.dxf"))).size > 12 * 1024 * 1024)
        throw new HttpError(422, "转换后DXF超过12MB，请分图上传");
      const result = await cadWorker(
        "analyze",
        (await readFile(path.join(dir, "converted.dxf"))).toString("base64"),
      );
      return {
        ...result,
        format: "dwg",
        conversion: "LibreDWG 0.13.3 → DXF",
        warnings: [
          "DWG基础二维内容转换；动态/代理/三维对象可能不完整，须对照原CAD确认，不能仅凭转换成功批准生产。",
          ...result.warnings,
        ],
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (format === "dxf") return cadWorker("analyze", bytes.toString("base64"));
  const mime =
    format === "pdf"
      ? "application/pdf"
      : format === "png"
        ? "image/png"
        : "image/jpeg";
  const native =
    format === "pdf" ? await cadWorker("pdf", bytes.toString("base64")) : null;
  const pages = native?.pages || (await rasterOriginal(bytes, mime));
  const dir = await mkdtemp(path.join(os.tmpdir(), "autinberg-cad-"));
  const evidence: any[] = native?.evidence || [];
  const warnings = [
    "图像/OCR结果仅供人工核对，未从像素推算生产尺寸；请确认单位和比例",
  ];
  warnings.push(...(native?.warnings || []));
  try {
    for (const [page, p] of pages.entries()) {
      if (native && !p.needsOcr) continue;
      await progress(`OCR第${page + 1}/${pages.length}页（待人工复核）`);
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
              id: `P${page + 1}-OCR-${evidence.length + 1}`,
              source: "ocr",
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
    vectors: native?.vectors || [],
    warnings,
    units: 0,
  };
}
