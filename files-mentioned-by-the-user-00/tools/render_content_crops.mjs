import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const root = process.cwd();
const outDir = path.join(root, "build", "content_crops");
const networkPath = path.join(root, "network_data.js");
const pageOcrDir = path.join(root, "build", "page_ocr");
const hdPageDir = path.join(root, "build", "page_images_hd");
const pdfPath = path.join(root, "chemistry_method.pdf");
const scale = Number(process.env.CONTENT_CROP_SCALE || 2);
const quality = Number(process.env.CONTENT_CROP_QUALITY || 0.92);

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const network = await readNetwork();
const nodes = network.nodes || [];
const nodesById = new Map(nodes.map(node => [node.id, node]));
const pageNodeByBookPage = new Map(nodes.filter(node => node.kind === "page" && node.page).map(node => [node.page, node]));
const pdfPageByBookPage = await readPageMap();
const typeNodes = nodes.filter(node => node.kind === "type");
const typeOrderByModule = groupTypeOrder(typeNodes);
const pdfCanvasCache = new Map();
const pdfDocument = existsSync(pdfPath)
  ? await pdfjs.getDocument({ data: new Uint8Array(await readFile(pdfPath)), disableWorker: true }).promise
  : null;

await mkdir(outDir, { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  scale,
  quality,
  pages: {},
  examples: {},
  warnings: []
};

let pageCount = 0;
let exampleCount = 0;

for (const node of nodes) {
  if (node.kind !== "page" || !node.page) continue;
  const result = await renderPageCrop(node);
  if (result) {
    manifest.pages[node.id] = result;
    pageCount += 1;
  }
}

for (const node of nodes) {
  if (node.kind !== "example") continue;
  const result = await renderExampleCrop(node);
  if (result) {
    manifest.examples[node.id] = result;
    exampleCount += 1;
  }
}

await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(JSON.stringify({ done: true, pageCount, exampleCount, warnings: manifest.warnings.length }, null, 2));

async function readNetwork() {
  const text = await readFile(networkPath, "utf8");
  return JSON.parse(text.replace(/^window\.NETWORK_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
}

async function readPageMap() {
  const map = new Map();
  const files = await readdir(pageOcrDir);
  for (const file of files) {
    if (!/^page_\d+\.json$/.test(file)) continue;
    const json = JSON.parse(await readFile(path.join(pageOcrDir, file), "utf8"));
    if (json.bookPage && json.pdfPage) map.set(json.bookPage, json.pdfPage);
  }
  return map;
}

function groupTypeOrder(types) {
  const groups = new Map();
  for (const type of types) {
    const pathKey = Array.isArray(type.path) ? type.path.slice(0, -1).join(" > ") : "";
    if (!groups.has(pathKey)) groups.set(pathKey, []);
    groups.get(pathKey).push(type);
  }
  return groups;
}

function nextTypeFor(typeNode) {
  if (!typeNode || !Array.isArray(typeNode.path)) return null;
  const key = typeNode.path.slice(0, -1).join(" > ");
  const group = typeOrderByModule.get(key) || [];
  const index = group.findIndex(type => type.id === typeNode.id);
  return index >= 0 ? group[index + 1] || null : null;
}

async function renderPageCrop(node) {
  try {
    const canvas = await canvasForBookPage(node.page);
    const fullBox = findContentBox(canvas, { x: 0, y: 0, w: canvas.width, h: canvas.height }, 2, 28);
    const crop = copyCrop(canvas, fullBox);
    const file = `page_${String(node.page).padStart(3, "0")}.jpg`;
    await saveJpeg(path.join(outDir, file), crop);
    return { file, width: crop.width, height: crop.height, source: `book:${node.page}` };
  } catch (error) {
    manifest.warnings.push({ node: node.id, kind: "page", message: String(error.message || error) });
    return null;
  }
}

async function renderExampleCrop(node) {
  const typeNode = nodesById.get(node.parent);
  const startBookPage = Array.isArray(node.pages) && node.pages.length ? node.pages[0] : typeNode?.page;
  const startPdfPage = pdfPageByBookPage.get(startBookPage);
  if (!typeNode || !startBookPage || !startPdfPage) {
    manifest.warnings.push({ node: node.id, kind: "example", message: "missing type or page mapping" });
    return null;
  }

  try {
    const nextType = nextTypeFor(typeNode);
    const nextPdfPage = nextType?.page ? pdfPageByBookPage.get(nextType.page) : null;
    const firstCanvas = await canvasForBookPage(startBookPage);
    const pageNode = pageNodeByBookPage.get(startBookPage);
    const firstStart = locateTypeStartRatio(typeNode, node, pageNode);
    const firstEnd = nextType?.page === startBookPage ? locateNextTypeRatio(nextType, pageNode, firstStart) : 0.988;
    const segments = [cropPageSegment(firstCanvas, firstStart, firstEnd)];
    const sources = [`book:${startBookPage}`];

    if (nextPdfPage && nextPdfPage > startPdfPage + 1) {
      for (let pdfPage = startPdfPage + 1; pdfPage < nextPdfPage; pdfPage += 1) {
        const canvas = await canvasForPdfPage(pdfPage);
        segments.push(cropFullContent(canvas));
        sources.push(`pdf:${pdfPage}`);
      }
    }

    const composite = composeVertical(segments);
    const file = `${node.id}.jpg`;
    await saveJpeg(path.join(outDir, file), composite);
    return {
      file,
      width: composite.width,
      height: composite.height,
      source: sources,
      type: typeNode.title,
      nextType: nextType?.title || null
    };
  } catch (error) {
    manifest.warnings.push({ node: node.id, kind: "example", message: String(error.message || error) });
    return null;
  }
}

function locateTypeStartRatio(typeNode, exampleNode, pageNode) {
  const pageLines = textLines(pageNode?.text || "");
  if (!pageLines.length) return 0.08;
  const exampleLines = textLines(exampleNode.text || typeNode.text || "");
  const candidates = [
    exampleLines.find(line => /例\s*\d+|【例/.test(line)),
    typeNode.title,
    exampleLines[0]
  ].filter(Boolean);

  let index = -1;
  for (const candidate of candidates) {
    index = findLineIndex(pageLines, candidate, 0);
    if (index >= 0) break;
  }
  if (index < 0) return 0.08;
  return clamp(0.05 + (index / Math.max(1, pageLines.length)) * 0.9 - 0.025, 0.02, 0.92);
}

function locateNextTypeRatio(nextType, pageNode, minStart) {
  const pageLines = textLines(pageNode?.text || "");
  const index = findLineIndex(pageLines, nextType.title, 0);
  if (index < 0) return 0.988;
  return clamp(0.05 + (index / Math.max(1, pageLines.length)) * 0.9 - 0.035, minStart + 0.18, 0.988);
}

function cropPageSegment(canvas, startRatio, endRatio) {
  const content = findContentBox(canvas, { x: 0, y: 0, w: canvas.width, h: canvas.height }, 2, 20);
  const y = clamp(Math.floor(canvas.height * startRatio), 0, canvas.height - 1);
  const bottom = clamp(Math.ceil(canvas.height * endRatio), y + 80, canvas.height);
  const loose = {
    x: content.x,
    y,
    w: content.w,
    h: bottom - y
  };
  const trimmed = findContentBox(canvas, loose, 2, 22);
  return copyCrop(canvas, trimmed);
}

function cropFullContent(canvas) {
  return copyCrop(canvas, findContentBox(canvas, { x: 0, y: 0, w: canvas.width, h: canvas.height }, 2, 28));
}

async function canvasForBookPage(bookPage) {
  const filename = `page_${String(bookPage).padStart(3, "0")}.jpg`;
  const filePath = path.join(hdPageDir, filename);
  if (existsSync(filePath)) return canvasFromImage(filePath);
  const pdfPage = pdfPageByBookPage.get(bookPage);
  if (!pdfPage) throw new Error(`no source image or pdf mapping for book page ${bookPage}`);
  return canvasForPdfPage(pdfPage);
}

async function canvasForPdfPage(pdfPage) {
  if (pdfCanvasCache.has(pdfPage)) return pdfCanvasCache.get(pdfPage);
  if (!pdfDocument) throw new Error("chemistry_method.pdf is required to render continuation pages");
  const page = await pdfDocument.getPage(pdfPage);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  pdfCanvasCache.set(pdfPage, canvas);
  return canvas;
}

async function canvasFromImage(filePath) {
  const image = await loadImage(filePath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  return canvas;
}

function findContentBox(canvas, rect, step = 2, pad = 16) {
  const ctx = canvas.getContext("2d");
  const x0 = clamp(Math.floor(rect.x), 0, canvas.width - 1);
  const y0 = clamp(Math.floor(rect.y), 0, canvas.height - 1);
  const x1 = clamp(Math.ceil(rect.x + rect.w), x0 + 1, canvas.width);
  const y1 = clamp(Math.ceil(rect.y + rect.h), y0 + 1, canvas.height);
  const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const width = x1 - x0;
  const height = y1 - y0;
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (isInk(r, g, b)) {
        if (x < left) left = x;
        if (y < top) top = y;
        if (x > right) right = x;
        if (y > bottom) bottom = y;
      }
    }
  }

  if (left > right || top > bottom) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const safeLeft = clamp(x0 + left - pad, 0, canvas.width - 1);
  const safeTop = clamp(y0 + top - pad, 0, canvas.height - 1);
  const safeRight = clamp(x0 + right + pad + step, safeLeft + 1, canvas.width);
  const safeBottom = clamp(y0 + bottom + pad + step, safeTop + 1, canvas.height);
  return { x: safeLeft, y: safeTop, w: safeRight - safeLeft, h: safeBottom - safeTop };
}

function isInk(r, g, b) {
  if (r < 244 || g < 244 || b < 244) return true;
  return Math.max(r, g, b) - Math.min(r, g, b) > 18;
}

function copyCrop(source, box) {
  const width = Math.max(1, Math.round(box.w));
  const height = Math.max(1, Math.round(box.h));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, width, height);
  return canvas;
}

function composeVertical(segments) {
  const realSegments = segments.filter(segment => segment && segment.width > 1 && segment.height > 1);
  const width = Math.max(...realSegments.map(segment => segment.width));
  const gap = realSegments.length > 1 ? 18 : 0;
  const height = realSegments.reduce((sum, segment) => sum + segment.height, 0) + gap * (realSegments.length - 1);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  for (const segment of realSegments) {
    const x = Math.round((width - segment.width) / 2);
    ctx.drawImage(segment, x, y);
    y += segment.height + gap;
  }
  return canvas;
}

async function saveJpeg(filePath, canvas) {
  const buffer = canvas.toBuffer("image/jpeg", quality);
  await writeFile(filePath, buffer);
}

function textLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^\d{3}$/.test(line));
}

function findLineIndex(lines, target, fromIndex = 0) {
  const wanted = normalizedLine(target);
  if (!wanted) return -1;
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, index) => {
    if (index < fromIndex) return;
    const current = normalizedLine(line);
    if (!current) return;
    const score = lineMatchScore(current, wanted);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return bestScore >= 0.48 ? best : -1;
}

function lineMatchScore(line, target) {
  if (line.includes(target) || target.includes(line)) return 1;
  const shortTarget = target.slice(0, Math.min(18, target.length));
  if (shortTarget.length >= 6 && line.includes(shortTarget)) return 0.86;
  let hits = 0;
  const step = Math.max(2, Math.floor(target.length / 8));
  for (let i = 0; i < target.length; i += step) {
    const token = target.slice(i, i + step);
    if (token.length >= 2 && line.includes(token)) hits += 1;
  }
  return hits / Math.max(1, Math.ceil(target.length / step));
}

function normalizedLine(line) {
  return String(line || "")
    .replace(/\s+/g, "")
    .replace(/[^\u3400-\u9fffA-Za-z0-9ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩIVX例类型模块章节√×+\-().（）【】]/g, "")
    .toLowerCase();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
