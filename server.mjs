// Zero-dependency Node ESM server.
//   - serves ./public as static files
//   - POST /api/triage  { "symptom": "..." }  ->  triage JSON
//
// Run:  ZAI_API_KEY=... node server.mjs   (or: npm start)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { triage } from "./lib/triage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  const payload =
    typeof body === "string" || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":
      headers["Content-Type"] || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function serveStatic(req, res, urlPath) {
  // Default to index.html; prevent path traversal.
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/index.html";
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    return send(res, 404, { error: "Not found" });
  }
  const data = await readFile(filePath);
  const ct = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/triage") {
    try {
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const symptom = parsed.symptom;
      if (!symptom || typeof symptom !== "string" || !symptom.trim()) {
        return send(res, 400, {
          error: "Request body must be JSON: { \"symptom\": \"...\" }",
        });
      }
      const result = await triage({ symptom });
      return send(res, 200, result);
    } catch (err) {
      console.error("[triage] error:", err.message);
      return send(res, 502, {
        error: "Triage failed.",
        detail: err.message,
      });
    }
  }

  if (req.method === "GET") {
    try {
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error("[static] error:", err.message);
      return send(res, 500, { error: "Server error" });
    }
  }

  return send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Clinical Triage Agent`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  UI:   ${url}`);
  console.log(`  API:  POST ${url}/api/triage   { "symptom": "..." }`);
  console.log(`  CLI:  node cli.mjs "crushing chest pain and SOB"`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Model: GLM-5.2 via Z.AI   |   Synthetic data only.\n`);
});
