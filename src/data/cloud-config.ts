export class CloudDataError extends Error {
  override readonly name = "CloudDataError";
}

interface CloudAccountLike {
  readonly emailVerified: boolean;
  readonly providerData: readonly { readonly providerId: string }[];
}

export function isVerifiedGoogleAccount(account: CloudAccountLike): boolean {
  return account.emailVerified
    && account.providerData.some(({ providerId }) => providerId === "google.com");
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
