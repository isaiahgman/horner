/** Compile-time only. A URL, browser preference, or account cannot enable QA. */
export const isQaPreview = import.meta.env.MODE === "qa";
export const qaCommitSha = import.meta.env.VITE_QA_COMMIT_SHA as string | undefined;
export const qaPrNumber = import.meta.env.VITE_QA_PR_NUMBER as string | undefined;

/** Separate local stores even when a developer serves both builds on localhost. */
export const localStorageNamespace = isQaPreview ? "qa-preview:" : "";
