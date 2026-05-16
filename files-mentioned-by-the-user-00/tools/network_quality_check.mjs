import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port = 9300 + Math.floor(Math.random() * 500);
const profileDir = path.join(root, "build", `edge-cdp-profile-${Date.now()}`);
const outPath = process.argv[2] || path.join(root, "build", "network_quality_check.json");
const screenshotCenter = process.argv.includes("--screenshot")
  ? process.argv[process.argv.indexOf("--screenshot") + 1]
  : "";

async function main() {
  await mkdir(path.dirname(outPath), { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const browser = spawn(edgePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--allow-file-access-from-files",
    "about:blank"
  ], { stdio: "ignore" });

  try {
    const page = await openPage();
    const client = new CDPClient(page.webSocketDebuggerUrl);
    await client.ready;
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 920,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.send("Page.navigate", { url: pathToFileURL(path.join(root, "index.html")).href });
    await sleep(900);
    await client.evaluate(`
      (() => {
        const style = document.createElement("style");
        style.textContent = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}";
        document.head.appendChild(style);
      })()
    `);

    const expression = screenshotCenter
      ? screenshotExpression(screenshotCenter)
      : scanExpression();
    const result = await client.evaluate(expression, true);

    if (screenshotCenter) {
      const shot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const shotPath = outPath.replace(/\.json$/i, ".png");
      await writeFile(shotPath, Buffer.from(shot.data, "base64"));
      result.screenshot = shotPath;
    }

    await writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
    console.log(JSON.stringify({
      outPath,
      centers: result.centers,
      failingCenters: result.failingCenters,
      stickyFailures: result.stickyFailures,
      textOverlaps: result.textOverlaps,
      lineNodeOverlaps: result.lineNodeOverlaps,
      lineLabelOverlaps: result.lineLabelOverlaps,
      screenshot: result.screenshot || null
    }, null, 2));
    await client.close();
  } finally {
    try {
      browser.kill("SIGKILL");
    } catch {}
    await sleep(1200);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function openPage() {
  await waitForJson();
  const targetUrl = `http://127.0.0.1:${port}/json/new`;
  await fetch(targetUrl, { method: "PUT" }).catch(() => fetch(targetUrl));
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(res => res.json());
  const page = list.find(item => item.type === "page");
  if (!page) throw new Error("No debuggable page found");
  return page;
}

async function waitForJson() {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {}
    await sleep(120);
  }
  throw new Error("Timed out waiting for Edge remote debugging");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CDPClient {
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
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
    }
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

function screenshotExpression(centerId) {
  return `
    (async () => {
      ${qualityHelpers()}
      focusNode(${JSON.stringify(centerId)}, false);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return collectNetworkQuality([${JSON.stringify(centerId)}], true);
    })()
  `;
}

function scanExpression() {
  return `
    (async () => {
      ${qualityHelpers()}
      return collectNetworkQuality(
        NETWORK_DATA.nodes
          .filter(node => node.centerable && ["root", "chapter", "module", "section", "type", "summary"].includes(node.kind))
          .map(node => node.id),
        false
      );
    })()
  `;
}

function qualityHelpers() {
  return String.raw`
    async function collectNetworkQuality(centerIds, keepSamples) {
      const result = {
        centers: centerIds.length,
        failingCenters: 0,
        stickyFailures: 0,
        textOverlaps: 0,
        lineNodeOverlaps: 0,
        lineLabelOverlaps: 0,
        failures: []
      };
      for (const id of centerIds) {
        focusNode(id, false);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const one = collectOneNetwork(id);
        result.stickyFailures += one.sticky.length;
        result.textOverlaps += one.text.length;
        result.lineNodeOverlaps += one.lineNode.length;
        result.lineLabelOverlaps += one.lineLabel.length;
        const failed = one.sticky.length || one.text.length || one.lineNode.length || one.lineLabel.length;
        if (failed) {
          result.failingCenters += 1;
          if (keepSamples || result.failures.length < 60) result.failures.push(one);
        }
      }
      return result;
    }

    function collectOneNetwork(centerId) {
      const nodes = [...document.querySelectorAll(".net-node")].map(el => ({
        type: "node",
        id: el.dataset.id,
        kind: el.dataset.kind,
        text: el.textContent.trim(),
        rect: rectOf(el)
      }));
      const labels = [...document.querySelectorAll(".edge-label-wrap")].map((wrap, index) => {
        const bg = wrap.querySelector(".edge-label-bg");
        const text = wrap.querySelector(".edge-label");
        return {
          type: "label",
          index,
          source: wrap.dataset.source,
          target: wrap.dataset.target,
          relation: wrap.dataset.relation,
          text: text ? text.textContent.trim() : "",
          rect: rectOf(bg || wrap)
        };
      }).filter(item => item.rect.width > 0 && item.rect.height > 0);
      const paths = [...document.querySelectorAll("path.edge")].map((path, index) => ({
        type: "path",
        index,
        source: path.dataset.source,
        target: path.dataset.target,
        relation: path.dataset.relation,
        path
      }));

      const text = [];
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          if (intersects(nodes[i].rect, nodes[j].rect, 2)) text.push(pair("node-node", centerId, nodes[i], nodes[j]));
        }
      }
      for (const node of nodes) {
        for (const label of labels) {
          if (intersects(node.rect, label.rect, 3)) text.push(pair("node-label", centerId, node, label));
        }
      }
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) {
          if (intersects(labels[i].rect, labels[j].rect, 3)) text.push(pair("label-label", centerId, labels[i], labels[j]));
        }
      }

      const sticky = [];
      for (const label of labels) {
        const path = paths.find(candidate => sameEdge(candidate, label));
        if (!path) {
          sticky.push({ centerId, type: "missing-path", label: compact(label) });
          continue;
        }
        const distance = distanceToPath(path.path, label.rect.cx, label.rect.cy);
        if (distance > 4.5) {
          sticky.push({ centerId, type: "label-detached", distance: Math.round(distance * 10) / 10, label: compact(label) });
        }
      }

      const lineNode = [];
      const lineLabel = [];
      for (const path of paths) {
        const samples = pathSamples(path.path, 42);
        for (const point of samples) {
          for (const node of nodes) {
            if (node.id === path.source || node.id === path.target) continue;
            if (pointInRect(point, node.rect, 5)) {
              lineNode.push({ centerId, edge: compact(path), node: compact(node) });
              break;
            }
          }
          for (const label of labels) {
            if (sameEdge(path, label)) continue;
            if (pointInRect(point, label.rect, 5)) {
              lineLabel.push({ centerId, edge: compact(path), label: compact(label) });
              break;
            }
          }
        }
      }

      return {
        centerId,
        centerTitle: NETWORK_DATA.nodes.find(node => node.id === centerId)?.title || centerId,
        text: text.slice(0, 10),
        sticky: sticky.slice(0, 10),
        lineNode: uniqueBy(JSON.stringify, lineNode).slice(0, 10),
        lineLabel: uniqueBy(JSON.stringify, lineLabel).slice(0, 10)
      };
    }

    function rectOf(el) {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        cx: rect.left + rect.width / 2,
        cy: rect.top + rect.height / 2
      };
    }

    function intersects(a, b, pad) {
      return !(a.right + pad <= b.left || b.right + pad <= a.left || a.bottom + pad <= b.top || b.bottom + pad <= a.top);
    }

    function pointInRect(point, rect, pad) {
      return point.x >= rect.left - pad && point.x <= rect.right + pad && point.y >= rect.top - pad && point.y <= rect.bottom + pad;
    }

    function sameEdge(a, b) {
      return a.source === b.source && a.target === b.target && a.relation === b.relation;
    }

    function pathSamples(path, count) {
      const total = path.getTotalLength();
      const matrix = path.getScreenCTM();
      const points = [];
      for (let i = 3; i <= count - 3; i += 1) {
        const raw = path.getPointAtLength(total * (i / count));
        const screen = new DOMPoint(raw.x, raw.y).matrixTransform(matrix);
        points.push({ x: screen.x, y: screen.y });
      }
      return points;
    }

    function distanceToPath(path, x, y) {
      let best = Infinity;
      for (const point of pathSamples(path, 90)) {
        best = Math.min(best, Math.hypot(point.x - x, point.y - y));
      }
      return best;
    }

    function compact(item) {
      return {
        id: item.id,
        kind: item.kind,
        source: item.source,
        target: item.target,
        relation: item.relation,
        text: item.text,
        index: item.index
      };
    }

    function pair(type, centerId, a, b) {
      return { centerId, type, a: compact(a), b: compact(b) };
    }

    function uniqueBy(keyFn, items) {
      const seen = new Set();
      const result = [];
      for (const item of items) {
        const key = keyFn(item);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
      }
      return result;
    }
  `;
}

await main();
