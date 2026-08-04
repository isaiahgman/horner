export const CLOUD_OWNER_EMAIL = "isaiahgathala@gmail.com";

export function isCloudPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = String((error as { readonly code: unknown }).code);
  return code === "permission-denied" || code === "firestore/permission-denied";
}
