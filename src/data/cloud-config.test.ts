import { describe, expect, it } from "vitest";

import {
  CloudDataError,
  isCloudDataError,
  isCloudPermissionError,
} from "./cloud-config.js";

describe("cloud error classification", () => {
  it("separates invalid cloud data from permission and network errors", () => {
    expect(isCloudDataError(new CloudDataError("invalid"))).toBe(true);
    expect(isCloudDataError(new Error("offline"))).toBe(false);
    expect(isCloudPermissionError({ code: "firestore/permission-denied" })).toBe(true);
    expect(isCloudPermissionError({ code: "firestore/unavailable" })).toBe(false);
  });
});
