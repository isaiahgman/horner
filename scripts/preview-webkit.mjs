import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preview } from "vite";

// WebKit applies the production CSP's upgrade-insecure-requests to loopback
// too. Serve the unchanged production bundle over HTTPS instead of relaxing CSP.
const directory = mkdtempSync(join(tmpdir(), "horner-webkit-tls-"));
let https;
try {
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  https = { key: readFileSync(key), cert: readFileSync(cert) };
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const server = await preview({
  preview: { host: "127.0.0.1", port: Number(process.argv[2] ?? 4174), strictPort: true, https },
});

const address = server.httpServer.address();
if (address && typeof address !== "string") {
  process.send?.({ origin: `https://127.0.0.1:${address.port}` });
}
