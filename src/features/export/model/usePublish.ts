import { computed, reactive, ref } from "vue";
import type {
  PublishSettings,
  RenderSnapshot,
  StudioDocument,
} from "../../../shared/types";
import {
  basePublish,
  estimateTotalBytes,
  formatBytes,
  publishArtwork,
  sanitizeTitle,
} from "../lib/publish";
import { artworkSizes } from "../lib/publish";

export function usePublish(doc: StudioDocument) {
  // Publishing settings live outside StudioDocument on purpose: editing the
  // artwork never mutates an in-flight export, and reopening a new export
  // starts from these defaults rather than inheriting author UI state.
  const settings = reactive<PublishSettings>(basePublish());
  const busy = ref(false);
  const progress = ref(0);
  const message = ref("");
  const result = ref<{ bytes: number; filename: string; imageBytes: number } | null>(
    null,
  );
  let controller: AbortController | null = null;

  const estimate = computed(() =>
    doc.asset
      ? estimateTotalBytes(
          { width: doc.asset.width, height: doc.asset.height },
          settings,
        )
      : 0,
  );
  const estimateLabel = computed(() =>
    doc.asset ? `约 ${formatBytes(estimate.value)}` : "导入照片后估算",
  );
  const largeWarning = computed(() => {
    if (!doc.asset) return "";
    const bytes = estimateTotalBytes(
      { width: doc.asset.width, height: doc.asset.height },
      settings,
    );
    if (bytes > 16 * 1024 * 1024)
      return "文件较大，接收者打开会偏慢。可降一档清晰度，或在照片质量上取舍。";
    if (bytes > 8 * 1024 * 1024)
      return "这是较大的单页文件，建议发送前确认接收者的网络与存储空间。";
    return "";
  });
  const widthHint = computed(() => {
    if (!doc.asset) return "";
    const width = Math.min(doc.asset.width, settings.width);
    return width < settings.width
      ? `原图宽 ${doc.asset.width}px，将按原尺寸导出`
      : `长边 ${width}px`;
  });

  function snapshot(): RenderSnapshot {
    return {
      asset: doc.asset!,
      projection: { ...doc.projection },
      edge: { ...doc.edge },
    };
  }

  async function publish() {
    if (!doc.asset || busy.value) return;
    busy.value = true;
    progress.value = 0;
    message.value = "";
    result.value = null;
    controller = new AbortController();
    try {
      // Capture the author's composition at click time; later edits are ignored.
      const frozen = snapshot();
      const frozenDoc: StudioDocument = {
        asset: frozen.asset,
        projection: frozen.projection,
        edge: frozen.edge,
      };
      const out = await publishArtwork(
        frozenDoc,
        { ...settings, title: sanitizeTitle(settings.title) },
        controller.signal,
        (n) => (progress.value = n),
      );
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = out.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      result.value = {
        bytes: out.htmlBytes,
        imageBytes: out.imageBytes,
        filename: out.filename,
      };
      message.value = `已导出单页作品 · ${formatBytes(out.htmlBytes)}`;
    } catch (e) {
      message.value = controller.signal.aborted
        ? "已取消导出"
        : e instanceof Error
          ? e.message
          : "导出失败";
    } finally {
      busy.value = false;
      controller = null;
    }
  }

  function cancel() {
    controller?.abort();
  }

  function resetSettings() {
    Object.assign(settings, basePublish());
  }

  return {
    settings,
    busy,
    progress,
    message,
    result,
    estimate,
    estimateLabel,
    widthHint,
    largeWarning,
    sizes: artworkSizes,
    publish,
    cancel,
    resetSettings,
  };
}
