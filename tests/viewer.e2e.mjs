import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const PORT = 4179;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function nearly(a, b, tolerance = 0.5) {
  return Math.abs(a - b) <= tolerance;
}

async function waitForServer(url, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start: ${url}`);
}

const server = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
);
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => process.stderr.write(d));

const workDir = await mkdtemp(path.join(tmpdir(), "orbit-viewer-test-"));
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader"] });
let exitCode = 0;

try {
  await waitForServer(BASE);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.querySelector(".source-card img") !== null,
    null,
    { timeout: 30000 },
  );

  // Author composition: tunnel, distinct angles, transparent feathered edge.
  await page.locator('button:has-text("时空隧道")').click();
  await page.locator('input[aria-label="水平旋转"]').fill("123");
  await page.locator('input[aria-label="俯仰角度"]').fill("22");
  await page.locator('input[aria-label="画面旋转"]').fill("14");
  await page.locator('input[aria-label="边缘羽化"]').fill("0.18");
  await page.locator('.check input[type=checkbox]').check();
  await page.waitForTimeout(300);

  // Preflight estimate visible before encoding, and reacts to sharpness.
  const estimateBefore = await page.locator(".size-estimate strong").innerText();
  check("preflight estimate shown before export", /约 .+/.test(estimateBefore), estimateBefore);
  await page.locator("#publish-size").selectOption("1024");
  const estimateSmall = await page.locator(".size-estimate strong").innerText();
  check(
    "estimate reacts to sharpness setting",
    estimateBefore !== estimateSmall,
    `${estimateBefore} -> ${estimateSmall}`,
  );
  await page.locator("#publish-size").selectOption("1536");
  await page.locator("#publish-title").fill("断网星球 <测试>");

  const beforeExport = await page.evaluate(() => ({
    yaw: Number(document.querySelector('input[aria-label="水平旋转"]').value),
  }));
  const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
  await page.locator('button:has-text("导出离线互动作品")').click();
  const download = await downloadPromise;
  const htmlPath = path.join(workDir, "artwork.html");
  await download.saveAs(htmlPath);
  const html = await readFile(htmlPath, "utf8");
  const downloadName = download.suggestedFilename();

  check("download is a single .html file", downloadName.endsWith(".html"), downloadName);
  check("html embeds only data: images", /data:image\/(webp|jpeg|png);base64,/.test(html));
  check("no external http(s) references in artwork", !/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(html));
  check("local file names are not embedded", !/山湖之间/.test(html) && !/panorama\.jpg/.test(html));
  check("payload title is escaped, not executable markup", html.includes("断网星球") && !html.includes("<测试>"));
  check("CSP blocks network at open time", /connect-src 'none'/.test(html));
  check("studio edit state did not mutate", beforeExport.yaw === 123);

  const payloadMatch = html.match(
    /<script type="application\/json" id="orbit-payload">([\s\S]*?)<\/script>/,
  );
  const payload = JSON.parse(payloadMatch[1]);
  check(
    "payload snapshots author composition",
    payload.projection.mode === "tunnel" &&
      nearly(payload.projection.yaw, 123) &&
      nearly(payload.projection.pitch, 22) &&
      nearly(payload.projection.roll, 14) &&
      payload.edge.transparent === true &&
      nearly(payload.edge.feather, 0.18),
    JSON.stringify({ p: payload.projection, e: payload.edge }),
  );

  // ---- open the exported file fully offline ------------------------------
  const offline = await browser.newContext({
    viewport: { width: 900, height: 1000 },
    offline: true,
    hasTouch: true,
    isMobile: false,
    deviceScaleFactor: 1,
  });
  const networkAttempts = [];
  await offline.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("file:") || url.startsWith("data:")) return route.continue();
    networkAttempts.push(url);
    return route.abort();
  });
  const viewer = await offline.newPage();
  const errors = [];
  viewer.on("pageerror", (e) => errors.push(String(e)));
  await viewer.goto("file://" + htmlPath, { waitUntil: "load" });
  await viewer.waitForFunction(
    () => document.getElementById("ov-loading").hidden === true,
    null,
    { timeout: 30000 },
  );
  await viewer.waitForTimeout(400);

  check("viewer boots offline with zero network attempts", networkAttempts.length === 0, networkAttempts.join(","));
  check("no uncaught page errors", errors.length === 0, errors.join(" | "));

  const initial = await viewer.evaluate(() => ({
    yaw: document.getElementById("ov-yaw").value,
    pitch: document.getElementById("ov-pitch").value,
    roll: document.getElementById("ov-roll").value,
    zoom: document.getElementById("ov-zoom").value,
    tunnelPressed: document.getElementById("ov-tunnel").getAttribute("aria-pressed"),
    planetPressed: document.getElementById("ov-planet").getAttribute("aria-pressed"),
    title: document.getElementById("ov-title").textContent,
    engineText: document.getElementById("ov-engine-label").textContent,
    meta: document.getElementById("ov-meta").textContent,
    loadingHidden: document.getElementById("ov-loading").hidden,
    canvas: (() => {
      const c = document.getElementById("ov-canvas");
      return { w: c.width, h: c.height };
    })(),
  }));
  check("viewer opens on the author's tunnel view", initial.tunnelPressed === "true" && initial.planetPressed === "false");
  check(
    "viewer restores author angles and zoom",
    nearly(Number(initial.yaw), 123, 1) &&
      nearly(Number(initial.pitch), 22, 1) &&
      nearly(Number(initial.roll), 14, 1) &&
      nearly(Number(initial.zoom), 1, 0.01),
    JSON.stringify(initial),
  );
  check("canvas is painted at device resolution", initial.canvas.w > 200 && initial.canvas.w === initial.canvas.h, JSON.stringify(initial.canvas));
  check("engine label reports active sampling path", /(纹理|软件)采样/.test(initial.engineText), initial.engineText);

  // Drag interaction changes yaw.
  const stage = viewer.locator("#ov-stage");
  const box = await stage.boundingBox();
  await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await viewer.mouse.down();
  await viewer.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 20, { steps: 6 });
  await viewer.mouse.up();
  await viewer.waitForTimeout(350);
  const dragged = await viewer.evaluate(() => ({
    yaw: Number(document.getElementById("ov-yaw").value),
    pitch: Number(document.getElementById("ov-pitch").value),
  }));
  check("pointer drag rotates the panorama", Math.abs(dragged.yaw - 123) > 5, JSON.stringify(dragged));

  // Zoom buttons + wheel.
  await viewer.locator("#ov-zoom-in").click();
  const zoomed = Number(await viewer.locator("#ov-zoom").inputValue());
  check("zoom control changes scale", zoomed > 1, String(zoomed));
  await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await viewer.mouse.wheel(0, -120);
  await viewer.waitForTimeout(200);
  const wheelZoom = Number(await viewer.locator("#ov-zoom").inputValue());
  check("wheel zooms", wheelZoom > zoomed, `${zoomed} -> ${wheelZoom}`);

  // Switch projection and back to author view.
  await viewer.locator("#ov-planet").click();
  await viewer.waitForTimeout(200);
  check("projection toggle reaches planet mode", (await viewer.locator("#ov-planet").getAttribute("aria-pressed")) === "true");
  await viewer.locator("#ov-reset").click();
  await viewer.waitForTimeout(300);
  const restored = await viewer.evaluate(() => ({
    yaw: Number(document.getElementById("ov-yaw").value),
    pitch: Number(document.getElementById("ov-pitch").value),
    roll: Number(document.getElementById("ov-roll").value),
    zoom: Number(document.getElementById("ov-zoom").value),
    tunnel: document.getElementById("ov-tunnel").getAttribute("aria-pressed"),
  }));
  check(
    "reset control restores exact author viewpoint",
    restored.tunnel === "true" &&
      nearly(restored.yaw, 123, 1) &&
      nearly(restored.pitch, 22, 1) &&
      nearly(restored.roll, 14, 1) &&
      nearly(restored.zoom, 1, 0.01),
    JSON.stringify(restored),
  );

  // Keyboard access.
  await viewer.locator("#ov-stage").focus();
  await viewer.keyboard.press("ArrowRight");
  await viewer.keyboard.press("ArrowRight");
  const keyYaw = Number(await viewer.locator("#ov-yaw").inputValue());
  check("keyboard arrows rotate", keyYaw > 123, String(keyYaw));
  await viewer.keyboard.press("0");
  check("key 0 resets view", nearly(Number(await viewer.locator("#ov-yaw").inputValue()), 123, 1));

  // Touch gestures: single-finger drag + two-finger pinch via CDP.
  const cdp = await offline.newCDPSession(viewer);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })),
    });
  const yawBeforeTouch = Number(await viewer.locator("#ov-yaw").inputValue());
  await touch("touchStart", [{ x: cx, y: cy }]);
  await touch("touchMove", [{ x: cx - 70, y: cy }]);
  await touch("touchEnd", []);
  await viewer.waitForTimeout(300);
  const yawAfterTouch = Number(await viewer.locator("#ov-yaw").inputValue());
  check("touch drag rotates", Math.abs(((yawAfterTouch - yawBeforeTouch + 540) % 360) - 180) > 3, `${yawBeforeTouch} -> ${yawAfterTouch}`);

  await viewer.locator("#ov-reset").click();
  const zoomBeforePinch = Number(await viewer.locator("#ov-zoom").inputValue());
  await touch("touchStart", [{ x: cx - 40, y: cy }, { x: cx + 40, y: cy }]);
  await touch("touchMove", [{ x: cx - 90, y: cy }, { x: cx + 90, y: cy }]);
  await touch("touchEnd", []);
  await viewer.waitForTimeout(300);
  const zoomAfterPinch = Number(await viewer.locator("#ov-zoom").inputValue());
  check("two-finger pinch zooms", zoomAfterPinch > zoomBeforePinch + 0.1, `${zoomBeforePinch} -> ${zoomAfterPinch}`);

  // Transparent edge: corner pixels must be transparent in both engines.
  async function cornerAlpha(engine) {
    await viewer.locator("#ov-reset").click();
    await viewer.selectOption("#ov-engine", engine);
    await viewer.waitForTimeout(700);
    return viewer.evaluate(() => {
      const c = document.getElementById("ov-canvas");
      const ctx = c.getContext("2d");
      const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        corner: px(2, 2),
        center: px(c.width >> 1, c.height >> 1),
        engine: document.getElementById("ov-engine-label").textContent,
        size: c.width,
      };
    });
  }
  const alphaGpu = await cornerAlpha("gpu");
  const alphaSoftware = await cornerAlpha("software");
  check(
    "transparent edge survives in texture path",
    alphaGpu.corner[3] < 12,
    JSON.stringify(alphaGpu),
  );
  check(
    "transparent edge survives in software path",
    alphaSoftware.corner[3] < 12,
    JSON.stringify(alphaSoftware),
  );
  check(
    "both paths agree the centre is opaque",
    alphaGpu.center[3] > 240 && alphaSoftware.center[3] > 240,
    `${alphaGpu.center} / ${alphaSoftware.center}`,
  );

  // Engine parity: screenshot the same view under each path and compare.
  await viewer.locator("#ov-reset").click();
  await viewer.selectOption("#ov-engine", "gpu");
  await viewer.waitForTimeout(800);
  const shotGpu = PNG.sync.read(await viewer.locator("#ov-canvas").screenshot());
  await viewer.selectOption("#ov-engine", "software");
  await viewer.waitForTimeout(1200);
  const shotSoftware = PNG.sync.read(await viewer.locator("#ov-canvas").screenshot());
  const diff = new PNG({ width: shotGpu.width, height: shotGpu.height });
  const mismatched = pixelmatch(
    shotGpu.data,
    shotSoftware.data,
    diff.data,
    shotGpu.width,
    shotGpu.height,
    { threshold: 0.25, includeAA: true },
  );
  const mismatchRatio = mismatched / (shotGpu.width * shotGpu.height);
  check(
    "texture and software sampling agree on composition",
    mismatchRatio < 0.04,
    `${(mismatchRatio * 100).toFixed(2)}% differing pixels`,
  );

  // Force software engine globally: runs with WebGL disabled.
  const noGlContext = await browser.newContext({
    viewport: { width: 800, height: 900 },
    offline: true,
    hasTouch: true,
  });
  await noGlContext.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (String(type).startsWith("webgl") || String(type).startsWith("experimental-webgl"))
        return null;
      return original.call(this, type, ...rest);
    };
  });
  await noGlContext.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("file:") || url.startsWith("data:")) return route.continue();
    return route.abort();
  });
  const fallbackPage = await noGlContext.newPage();
  await fallbackPage.goto("file://" + htmlPath, { waitUntil: "load" });
  await fallbackPage.waitForFunction(
    () => document.getElementById("ov-loading").hidden === true,
    null,
    { timeout: 30000 },
  );
  await fallbackPage.waitForTimeout(600);
  const noGl = await fallbackPage.evaluate(() => ({
    engine: document.getElementById("ov-engine-label").textContent,
    canvas: document.getElementById("ov-canvas").width,
    errorHidden: document.getElementById("ov-error").hidden,
  }));
  check(
    "no-WebGL device still renders via software path",
    noGl.errorHidden === true && /软件采样/.test(noGl.engine) && noGl.canvas > 200,
    JSON.stringify(noGl),
  );

  // Corrupt the embedded photo: degraded UI must appear with author poster.
  const brokenHtml = html.replace(
    /(<script type="application\/json" id="orbit-payload">[\s\S]*?data:image\/(?:webp|jpeg|png);base64,)[A-Za-z0-9+/=]{40}/,
    "$1AAAA____",
  );
  const brokenPath = path.join(workDir, "broken.html");
  await (await import("node:fs/promises")).writeFile(brokenPath, brokenHtml, "utf8");
  const brokenPage = await offline.newPage();
  await brokenPage.goto("file://" + brokenPath, { waitUntil: "load" });
  await brokenPage.waitForTimeout(1500);
  const broken = await brokenPage.evaluate(() => ({
    errorHidden: document.getElementById("ov-error").hidden,
    errorText: document.getElementById("ov-error-text").textContent,
    posterHidden: document.getElementById("ov-poster").hidden,
    loadingHidden: document.getElementById("ov-loading").hidden,
  }));
  check(
    "decode failure shows clear degraded state",
    broken.errorHidden === false &&
      broken.loadingHidden === true &&
      broken.errorText.length > 0,
    JSON.stringify(broken),
  );
  check("degraded state keeps the author poster", broken.posterHidden === false, JSON.stringify(broken));

  await noGlContext.close();
  await offline.close();
  await context.close();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await rm(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  exitCode = 1;
  for (const f of failed) console.log(`  FAILED: ${f.name} ${f.detail}`);
}
process.exit(exitCode);
