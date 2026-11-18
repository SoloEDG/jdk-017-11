import type {
  ArtworkFormat,
  ArtworkPayload,
  Projection,
  Edge,
  PublishSettings,
  RendererPreference,
  StudioDocument,
} from "../../../shared/types";
import { renderRows } from "../../projection";
import viewerRuntime from "./viewer/runtime.js?raw";
import viewerStyles from "./viewer/viewer.css?raw";

export const artworkSizes = [
  { value: 1024, label: "轻量", hint: "1024 · 手机与慢速网络" },
  { value: 1536, label: "均衡", hint: "1536 · 清晰度与体积平衡" },
  { value: 2048, label: "细腻", hint: "2048 · 高分屏推荐" },
  { value: 3072, label: "剧院", hint: "3072 · 大屏与近距观看" },
] as const;

export const publishFormats: {
  value: ArtworkFormat;
  label: string;
  hint: string;
}[] = [
  { value: "webp", label: "WebP", hint: "体积更小" },
  { value: "jpeg", label: "JPG", hint: "兼容最广" },
  { value: "png", label: "PNG", hint: "无损、可透明" },
];

export const rendererChoices: {
  value: RendererPreference;
  label: string;
  hint: string;
}[] = [
  { value: "auto", label: "自动", hint: "有显卡时纹理采样，否则软件采样" },
  { value: "gpu", label: "纹理采样", hint: "WebGL 采样，适合高分屏" },
  { value: "software", label: "软件采样", hint: "无加速设备也可拖动" },
];

export const basePublish = (): PublishSettings => ({
  title: "我的星球",
  width: 2048,
  format: "webp",
  quality: 0.82,
  renderer: "auto",
});

export const mimeOf = (format: ArtworkFormat) =>
  format === "png"
    ? "image/png"
    : format === "jpeg"
      ? "image/jpeg"
      : "image/webp";

export const extensionOf = (format: ArtworkFormat) =>
  format === "png" ? "png" : format === "jpeg" ? "jpg" : "webp";

const viewerBytes = () => viewerRuntime.length + viewerStyles.length + 9000;

export function effectiveWidth(assetWidth: number, settings: PublishSettings) {
  return Math.max(64, Math.min(assetWidth, settings.width));
}

/** Pre-flight estimate shown before encoding; real bytes are reported after export. */
export function estimateArtworkBytes(
  asset: { width: number; height: number },
  settings: PublishSettings,
) {
  const width = effectiveWidth(asset.width, settings);
  const height = Math.max(32, Math.round((width * asset.height) / asset.width));
  const pixels = width * height;
  if (settings.format === "png") return Math.round(pixels * 0.58 + 40960);
  const bytesPerPixel =
    settings.format === "webp"
      ? 0.035 + settings.quality * 0.1
      : 0.05 + settings.quality * 0.12;
  return Math.round(pixels * bytesPerPixel + 24576);
}

export function estimateTotalBytes(
  asset: { width: number; height: number },
  settings: PublishSettings,
) {
  // Base64 inflates the embedded photo by 4/3; the viewer script and poster add the rest.
  return Math.round(estimateArtworkBytes(asset, settings) * 1.34) + viewerBytes() + 24000;
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function sanitizeTitle(title: string) {
  const trimmed = title.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60);
  return trimmed || "我的星球";
}

export function fileTitle(title: string) {
  // Used only for the download attribute, never inside executable document content.
  return (
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "orbit-artwork"
  );
}

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取导出图片"));
    reader.readAsDataURL(blob);
  });

const toBlob = (canvas: HTMLCanvasElement, mime: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("图片编码失败，请换一种格式"))),
      mime,
      quality,
    ),
  );

async function encodePanorama(
  doc: StudioDocument,
  settings: PublishSettings,
  signal: AbortSignal,
) {
  if (!doc.asset) throw new Error("请先导入一张全景照片");
  signal.throwIfAborted();
  const width = effectiveWidth(doc.asset.width, settings);
  const height = Math.max(
    32,
    Math.round((width * doc.asset.height) / doc.asset.width),
  );
  const source = document.createElement("canvas");
  source.width = doc.asset.width;
  source.height = doc.asset.height;
  source.getContext("2d")!.putImageData(doc.asset.data, 0, 0);
  const scaled = document.createElement("canvas");
  scaled.width = width;
  scaled.height = height;
  const ctx = scaled.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  signal.throwIfAborted();
  const blob = await toBlob(
    scaled,
    mimeOf(settings.format),
    settings.format === "png" ? undefined : settings.quality,
  );
  if (settings.format === "webp" && blob.type !== "image/webp")
    throw new Error("当前浏览器无法编码 WebP，请选择 JPG 或 PNG");
  signal.throwIfAborted();
  return {
    blob,
    dataUrl: await readAsDataUrl(blob),
    width,
    height,
  };
}

async function renderPoster(
  doc: StudioDocument,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!doc.asset) return undefined;
  try {
    const size = 360;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const snapshot = {
      asset: doc.asset,
      projection: { ...doc.projection },
      // The poster is a JPEG fallback, so it must be flattened onto the matte.
      edge: { ...doc.edge, transparent: false },
    };
    const image = ctx.createImageData(size, size);
    renderRows(snapshot, image, 0, size);
    signal.throwIfAborted();
    ctx.putImageData(image, 0, 0);
    return await readAsDataUrl(
      await toBlob(canvas, "image/jpeg", 0.72),
    );
  } catch {
    // A missing poster only weakens the degraded state, never blocks export.
    return undefined;
  }
}

export function buildPayload(
  doc: StudioDocument,
  settings: PublishSettings,
  image: { dataUrl: string; width: number; height: number },
  poster?: string,
): ArtworkPayload {
  return {
    version: 1,
    title: sanitizeTitle(settings.title),
    image: {
      dataUrl: image.dataUrl,
      width: image.width,
      height: image.height,
    },
    // Snapshot the author state so later studio edits never leak into an export.
    projection: { ...doc.projection },
    edge: { ...doc.edge },
    renderer: settings.renderer,
    createdAt: new Date().toISOString(),
    poster,
  };
}

export function escapeJsonForHtml(json: string) {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildViewerHtml(payload: ArtworkPayload) {
  const json = escapeJsonForHtml(JSON.stringify(payload));
  const title = escapeHtml(payload.title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'">
<title>${title} · ORBIT 离线星球</title>
<style>${viewerStyles}</style>
</head>
<body>
<div id="orbit-viewer">
  <header class="ov-head">
    <div class="ov-brand" aria-hidden="true">◍</div>
    <div class="ov-heading">
      <span class="ov-eyebrow">ORBIT · 离线互动作品</span>
      <h1 id="ov-title">${title}</h1>
    </div>
    <p class="ov-offline"><i aria-hidden="true"></i>离线单页 · 不联网</p>
  </header>
  <main class="ov-main">
    <div class="ov-stage-wrap">
      <div class="ov-stage" id="ov-stage" tabindex="0" aria-label="可拖动探索的星球全景">
        <img id="ov-poster" alt="" hidden>
        <canvas id="ov-canvas" role="img" aria-label="可拖动探索的星球全景，使用下方控件或方向键旋转"></canvas>
        <div class="ov-loading" id="ov-loading" role="status">正在准备离线预览…</div>
        <div class="ov-error" id="ov-error" role="alert" hidden>
          <strong>交互预览无法打开</strong>
          <p id="ov-error-text"></p>
          <p class="ov-error-hint">本页完全离线，不依赖网络。请确认文件下载完整，或请作者重新导出。</p>
        </div>
        <div class="ov-notice" id="ov-notice" role="status" hidden></div>
      </div>
      <p class="ov-caption">
        <span id="ov-mode-label">小行星视角</span>
        <span id="ov-engine-label">正在初始化查看引擎</span>
      </p>
    </div>
    <section class="ov-panel" aria-label="查看控制">
      <div class="ov-modes" role="group" aria-label="投影方式">
        <button type="button" id="ov-planet" aria-pressed="true">行星</button>
        <button type="button" id="ov-tunnel" aria-pressed="false">隧道</button>
      </div>
      <div class="ov-actions">
        <button type="button" id="ov-reset" class="ov-primary">恢复作者视角</button>
        <button type="button" id="ov-zoom-out" aria-label="缩小">−</button>
        <button type="button" id="ov-zoom-in" aria-label="放大">＋</button>
      </div>
      <details class="ov-advanced" open>
        <summary>精确取景</summary>
        <div class="ov-sliders">
          <label>水平旋转 <output id="ov-yaw-out"></output>
            <input id="ov-yaw" type="range" min="0" max="359" step="1" aria-label="水平旋转">
          </label>
          <label>俯仰角度 <output id="ov-pitch-out"></output>
            <input id="ov-pitch" type="range" min="-85" max="85" step="1" aria-label="俯仰角度">
          </label>
          <label>画面旋转 <output id="ov-roll-out"></output>
            <input id="ov-roll" type="range" min="0" max="359" step="1" aria-label="画面旋转">
          </label>
          <label>缩放 <output id="ov-zoom-out-label"></output>
            <input id="ov-zoom" type="range" min="0.3" max="3" step="0.01" aria-label="缩放">
          </label>
        </div>
      </details>
      <label class="ov-engine-field">查看引擎
        <select id="ov-engine" aria-label="查看引擎">
          <option value="auto">自动（推荐）</option>
          <option value="gpu">纹理采样 · 高分屏</option>
          <option value="software">软件采样 · 兼容优先</option>
        </select>
      </label>
      <p class="ov-hint">拖动旋转 · 双指或滚轮缩放 · 方向键微调 · P 切换投影 · 0 恢复作者视角</p>
      <p class="ov-status" id="ov-status" aria-live="polite"></p>
      <p class="ov-meta" id="ov-meta"></p>
    </section>
  </main>
</div>
<script type="application/json" id="orbit-payload">${json}</script>
<script>${viewerRuntime}</script>
</body>
</html>`;
}

export async function publishArtwork(
  doc: StudioDocument,
  settings: PublishSettings,
  signal: AbortSignal,
  progress: (n: number) => void,
) {
  progress(0.04);
  const image = await encodePanorama(doc, settings, signal);
  progress(0.45);
  const poster = await renderPoster(doc, signal);
  progress(0.7);
  const payload = buildPayload(doc, settings, image, poster);
  const html = buildViewerHtml(payload);
  progress(0.94);
  signal.throwIfAborted();
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  progress(1);
  return {
    blob,
    payload,
    imageBytes: image.blob.size,
    htmlBytes: blob.size,
    filename: `orbit-${fileTitle(payload.title)}-${extensionOf(settings.format)}.html`,
  };
}

export function projectionSummary(projection: Projection, edge: Edge) {
  return `${projection.mode === "planet" ? "行星" : "隧道"} · 水平 ${Math.round(
    projection.yaw,
  )}° · 俯仰 ${Math.round(projection.pitch)}° · 旋转 ${Math.round(
    projection.roll,
  )}° · 缩放 ${projection.zoom.toFixed(2)}× · ${
    edge.transparent ? "透明底" : "不透明底"
  }`;
}
