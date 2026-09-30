import type { ImageAttachment } from "../../../shared/chat";

// Vision models turn an image into tokens in proportion to its size: a phone photo
// (4000×3000) would cost thousands of tokens and seconds of extra processing, while
// 1280 px on the longest side keeps text in screenshots readable at a fraction of it.
const MAX_SIDE = 1280;
const QUALITY = 0.85;

export const isImage = (file: File) => /^image\/(png|jpeg|webp|gif)$/.test(file.type);

// Shrink (if needed) and re-encode an image in the browser before it's uploaded.
export async function prepareImage(file: File): Promise<ImageAttachment> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff"; // JPEG has no transparency: put transparent areas on white
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
  return { name: file.name.replace(/\.\w+$/, "") + ".jpg", mime: "image/jpeg", dataUrl };
}
