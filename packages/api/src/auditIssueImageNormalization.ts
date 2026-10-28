import { maxFilenameBytes, normalizeFilename } from "./filenames";
import { BodyReadTimeoutError, readBodyWithLimit } from "./storage";

export const maxImageBytes = 10 * 1024 * 1024;
export const maxImageReadMilliseconds = 60_000;
const maxImageDimension = 12_000;
const maxImagePixels = 40_000_000;

export async function parseImageUpload(
  request: Request,
  filename: string | undefined,
): Promise<
  | { bytes: Uint8Array; filename: string }
  | { error: string; status: 400 | 408 | 413 }
> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
    return { error: "Images must be 10 MB or smaller.", status: 413 };
  }
  const contentType = request.headers.get("content-type") ?? "";
  const declaredType = (contentType.split(";", 1)[0] ?? "").toLowerCase();
  if (
    declaredType !== "application/octet-stream" &&
    !supportedImageType(declaredType)
  ) {
    return {
      error: "Images must be JPEG, PNG, GIF, or WebP files.",
      status: 400,
    };
  }
  let requestBytes: Uint8Array | null;
  try {
    requestBytes = await readBodyWithLimit(
      request.body,
      maxImageBytes,
      maxImageReadMilliseconds,
    );
  } catch (cause) {
    if (cause instanceof BodyReadTimeoutError) {
      return {
        error: "Images must finish uploading within 60 seconds.",
        status: 408,
      };
    }
    throw cause;
  }
  if (requestBytes === null) {
    return { error: "Images must be 10 MB or smaller.", status: 413 };
  }
  if (requestBytes.byteLength === 0) {
    return { error: "The uploaded file is not a valid image.", status: 400 };
  }
  return { bytes: requestBytes, filename: filename || "issue-image" };
}

export function normalizedImageFilename(filename: string, extension: string) {
  const normalized = normalizeFilename(filename, "issue-image");
  const dotIndex = normalized.lastIndexOf(".");
  const stem = dotIndex > 0 ? normalized.slice(0, dotIndex) : normalized;
  const suffix = `.${extension}`;
  const suffixBytes = new TextEncoder().encode(suffix).byteLength;
  const trimmedStem = normalizeFilename(
    stem,
    "issue-image",
    maxFilenameBytes - suffixBytes,
  );
  return `${trimmedStem}${suffix}`;
}

function supportedImageType(format: string) {
  switch (format.toLowerCase()) {
    case "image/png":
    case "png":
      return { contentType: "image/png", extension: "png" } as const;
    case "image/jpeg":
    case "jpeg":
    case "jpg":
      return { contentType: "image/jpeg", extension: "jpg" } as const;
    case "image/gif":
    case "gif":
      return { contentType: "image/gif", extension: "gif" } as const;
    case "image/webp":
    case "webp":
      return { contentType: "image/webp", extension: "webp" } as const;
    default:
      return null;
  }
}

export async function validateImage(images: ImagesBinding, bytes: Uint8Array) {
  let imageInfo: ImageInfoResponse;
  const input = new Blob([bytes]);
  try {
    imageInfo = await images.info(input.stream());
  } catch {
    return {
      error: "The uploaded file is not a valid image.",
      status: 400,
    } as const;
  }
  const imageType = supportedImageType(imageInfo.format);
  if (!imageType || !("width" in imageInfo)) {
    return {
      error: "Images must be JPEG, PNG, GIF, or WebP files.",
      status: 400,
    } as const;
  }
  const { height, width } = imageInfo;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > maxImageDimension ||
    height > maxImageDimension ||
    width * height > maxImagePixels
  ) {
    return {
      error:
        "Images must be no larger than 12,000 pixels per side and 40 megapixels.",
      status: 400,
    } as const;
  }
  try {
    const normalized = await images
      .input(input.stream())
      .output({ anim: false, format: imageType.contentType });
    const normalizedImageType = supportedImageType(normalized.contentType());
    if (normalizedImageType?.contentType !== imageType.contentType) {
      return {
        error: "The uploaded image could not be normalized safely.",
        status: 400,
      } as const;
    }
    return {
      imageType: normalizedImageType,
      stream: normalized.image(),
    } as const;
  } catch {
    return {
      error: "The uploaded image could not be normalized safely.",
      status: 400,
    } as const;
  }
}
