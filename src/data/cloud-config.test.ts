import { describe, expect, it } from "vitest";

import {
  CloudDataError,
  isCloudDataError,
  isCloudPermissionError,
  isVerifiedGoogleAccount,
} from "./cloud-config.js";

describe("cloud error classification", () => {
  it("separates invalid cloud data from permission and network errors", () => {
    expect(isCloudDataError(new CloudDataError("invalid"))).toBe(true);
    expect(isCloudDataError(new Error("offline"))).toBe(false);
    expect(isCloudPermissionError({ code: "firestore/permission-denied" })).toBe(true);
    expect(isCloudPermissionError({ code: "firestore/unavailable" })).toBe(false);
  });
});

describe("cloud account eligibility", () => {
  it("accepts only verified Google accounts", () => {
    expect(isVerifiedGoogleAccount({
      emailVerified: true,
      providerData: [{ providerId: "google.com" }],
    })).toBe(true);
    expect(isVerifiedGoogleAccount({
      emailVerified: false,
      providerData: [{ providerId: "google.com" }],
    })).toBe(false);
    expect(isVerifiedGoogleAccount({
      emailVerified: true,
      providerData: [{ providerId: "password" }],
    })).toBe(false);
  });
});
