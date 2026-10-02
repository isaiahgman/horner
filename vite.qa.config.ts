import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type Plugin } from "vite";
import baseConfig from "./vite.config.js";

// Fail closed rather than shipping an unidentified or production-connected build.
const sha = process.env.QA_COMMIT_SHA ?? "0000000000000000000000000000000000000000";
const pr = process.env.QA_PR_NUMBER ?? "0";
if (!/^[a-f0-9]{40}$/.test(sha) || !/^\d+$/.test(pr)) {
  throw new Error("QA_COMMIT_SHA must be a full lowercase commit hash and QA_PR_NUMBER numeric.");
}
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const isolation: Plugin = {
  name: "qa-preview-isolation",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "./data/cloud.js" && importer?.endsWith("/src/App.tsx")) {
      return fileURLToPath(new URL("./src/data/cloud-preview.ts", import.meta.url));
    }
    return null;
  },
  transformIndexHtml: {
    order: "post",
    handler(html) {
      return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, "").replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    <meta name="robots" content="noindex,nofollow,noarchive">`)
        .replace("<title>Next Ten</title>", "<title>QA Preview · Next Ten</title>");
    },
  },
  generateBundle(_options, bundle) {
    for (const entry of Object.values(bundle)) {
      if (entry.type !== "chunk") continue;
      if (Object.keys(entry.modules).some((id) => /[/\\]node_modules[/\\](?:@firebase|firebase)[/\\]/.test(id))) {
        throw new Error("QA preview contains a Firebase runtime module.");
      }
      if (/isaiahgathala@gmail\.com|horner-next-ten-isaiah|331301995758|AIzaSy|identitytoolkit\.googleapis\.com|firestore\.googleapis\.com/.test(entry.code)) {
        throw new Error("QA preview contains production Firebase configuration or endpoints.");
      }
    }
    this.emitFile({ type: "asset", fileName: "qa-build.json", source: JSON.stringify({
      schema: 1, mode: "qa", commit: sha, pr: Number(pr),
    }) });
  },
};

export default defineConfig(mergeConfig(baseConfig, {
  define: {
    "import.meta.env.VITE_QA_COMMIT_SHA": JSON.stringify(sha),
    "import.meta.env.VITE_QA_PR_NUMBER": JSON.stringify(pr),
  },
  build: { outDir: "dist-qa", sourcemap: false },
  plugins: [isolation],
}));
