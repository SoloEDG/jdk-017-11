export interface Projection {
  mode: "planet" | "tunnel";
  zoom: number;
  yaw: number;
  pitch: number;
  roll: number;
}
export interface Edge {
  seam: number;
  feather: number;
  background: string;
  transparent: boolean;
}
export interface Asset {
  id: string;
  name: string;
  width: number;
  height: number;
  data: ImageData;
  thumbnail: string;
}
export interface StudioDocument {
  asset: Asset | null;
  projection: Projection;
  edge: Edge;
}
export interface ExportSettings {
  size: number;
  format: "png" | "jpeg";
  quality: number;
}
export interface RenderSnapshot {
  asset: Asset;
  projection: Projection;
  edge: Edge;
}

export type RendererPreference = "auto" | "gpu" | "software";
export type ArtworkFormat = "webp" | "jpeg" | "png";

export interface PublishSettings {
  title: string;
  width: number;
  format: ArtworkFormat;
  quality: number;
  renderer: RendererPreference;
}

export interface ArtworkPayload {
  version: 1;
  title: string;
  image: { dataUrl: string; width: number; height: number };
  projection: Projection;
  edge: Edge;
  renderer: RendererPreference;
  createdAt: string;
  /** Author-view JPEG used only when interactive rendering fails. */
  poster?: string;
}
