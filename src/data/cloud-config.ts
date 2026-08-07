export const CLOUD_OWNER_EMAIL = "isaiahgathala@gmail.com";

export class CloudDataError extends Error {
  override readonly name = "CloudDataError";
}

export function isCloudDataError(error: unknown): error is CloudDataError {
  return error instanceof Error && error.name === "CloudDataError";
}

export function isCloudPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = String((error as { readonly code: unknown }).code);
  return code === "permission-denied" || code === "firestore/permission-denied";
}
