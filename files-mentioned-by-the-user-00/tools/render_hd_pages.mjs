import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const pdfPath = process.env.PDF_PATH || path.join(root, "chemistry_method.pdf");
const outDir = path.join(root, "build", "page_images_hd");
const port = 12300 + Math.floor(Math.random() * 500);
const profileDir = path.join(root, "build", `edge-pdf-render-${Date.now()}`);
const scale = Number(process.env.HD_SCALE || 2);
const quality = Number(process.env.HD_QUALITY || 0.86);
const limit = Number(process.env.HD_LIMIT || 0);

async function main() {
  if (!existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  await mkdir(outDir, { recursive: true });
  await writeRenderPage();

  const records = await pageRecords();
  const wanted = limit ? records.slice(0, limit) : records;
  const browser = spawn(edgePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--disable-gpu",
    "--allow-file-access-from-files",
    "about:blank"
  ], { stdio: "ignore" });

  try {
    const client = await openClient();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.navigate", { url: pathToFileURL(path.join(root, "build", "pdf_render.html")).href });
    await waitUntilReady(client);
    await initPdf(client);

    let rendered = 0;
    for (const record of wanted) {
      const file = path.join(outDir, `page_${String(record.bookPage).padStart(3, "0")}.jpg`);
      if (existsSync(file)) continue;
      const result = await client.eval(`renderPdfPage(${record.pdfPage}, ${scale}, ${quality})`);
      await writeFile(file, Buffer.from(result.data.split(",")[1], "base64"));
      rendered += 1;
      if (rendered % 25 === 0 || rendered === 1) {
        console.log(JSON.stringify({ rendered, bookPage: record.bookPage, pdfPage: record.pdfPage, width: result.width, height: result.height }));
      }
    }
    console.log(JSON.stringify({ done: true, requested: wanted.length, rendered }));
    client.close();
  } finally {
    browser.kill("SIGKILL");
    await sleep(1000);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function pageRecords() {
  const files = await import("node:fs/promises").then(fs => fs.readdir(path.join(root, "build", "page_ocr")));
  const records = [];
  for (const file of files) {
    if (!/^page_\d+\.json$/.test(file)) continue;
    const json = JSON.parse(await readFile(path.join(root, "build", "page_ocr", file), "utf8"));
    if (json.bookPage && json.pdfPage) records.push({ bookPage: json.bookPage, pdfPage: json.pdfPage });
  }
  return records.sort((a, b) => a.bookPage - b.bookPage);
}

async function writeRenderPage() {
  const html = `<!doctype html><meta charset="utf-8">
<script type="module">
  const pdfjs = await import("../node_modules/pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = ${JSON.stringify(pathToFileURL(path.join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.mjs")).href)};
  let pdfDoc = null;
  window.initPdf = async function(url) {
    pdfDoc = await pdfjs.getDocument({ url }).promise;
    return pdfDoc.numPages;
  };
  window.renderPdfPage = async function(pdfPage, scale, quality) {
    const page = await pdfDoc.getPage(pdfPage);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    await page.render({ canvasContext: context, viewport }).promise;
    return {
      width: canvas.width,
      height: canvas.height,
      data: canvas.toDataURL("image/jpeg", quality)
    };
  };
  window.ready = true;
</script>`;
  await writeFile(path.join(root, "build", "pdf_render.html"), html, "utf8");
}

async function initPdf(client) {
  const url = pathToFileURL(pdfPath).href;
  return client.eval(`initPdf(${JSON.stringify(url)})`);
}

async function openClient() {
  await waitForJson();
  await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" }).catch(() => fetch(`http://127.0.0.1:${port}/json/new`));
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const page = targets.find(item => item.type === "page");
  const client = new CDP(page.webSocketDebuggerUrl);
  await client.ready;
  return client;
}

async function waitForJson() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("Timed out waiting for Edge");
}

async function waitUntilReady(client) {
  for (let i = 0; i < 120; i += 1) {
    if (await client.eval("Boolean(window.ready)")) return;
    await sleep(100);
  }
  throw new Error("Timed out waiting for PDF renderer");
}

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

await main();
