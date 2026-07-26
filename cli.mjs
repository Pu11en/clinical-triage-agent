#!/usr/bin/env node
// Command-line triage.
//   node cli.mjs "crushing chest pain and shortness of breath"
//   node cli.mjs "$(cat complaint.txt)"
//   echo "I've had a sore throat for two days" | node cli.mjs

import { triage } from "./lib/triage.mjs";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function colorFor(level) {
  return {
    EMERGENCY: "\x1b[41;97m", // red bg, white text
    URGENT_CARE: "\x1b[43;30m", // yellow bg, black text
    ROUTINE: "\x1b[46;30m", // cyan bg, black text
    SELF_CARE: "\x1b[42;30m", // green bg, black text
  }[level] || "\x1b[47;30m";
}
const RESET = "\x1b[0m";

function sourceLabel(source, kbCache) {
  if (source === "no source") return "no source";
  const label = kbCache.get(source);
  return label || source;
}

async function main() {
  let symptom = process.argv.slice(2).join(" ").trim();
  if (!symptom && !process.stdin.isTTY) {
    const piped = await readStdin();
    if (piped) symptom = piped;
  }
  if (!symptom) {
    console.error(
      "Usage: node cli.mjs \"<symptom or complaint>\"\n" +
        '  e.g. node cli.mjs "crushing chest pain and shortness of breath"'
    );
    process.exit(64);
  }

  const { getAllSources } = await import("./lib/retrieve.mjs");
  const kbCache = new Map(getAllSources().map((s) => [s.id, s.source]));

  const result = await triage({ symptom });

  // Pretty human summary
  console.log("\n" + "═".repeat(64));
  console.log("  CLINICAL TRIAGE  —  synthetic demo, not a diagnosis");
  console.log("═".repeat(64));
  console.log(`  Complaint : ${symptom}`);
  console.log(
    `  Triage    : ${colorFor(result.triage)} ${result.triage} ${RESET}`
  );
  console.log(`  Safety    : frozen node ${
    result.meta.frozenSafetyEngaged ? "ENGAGED" : "not engaged"
  }`);

  if (result.redFlags.length) {
    console.log("\n  Red flags / escalation:");
    for (const r of result.redFlags) {
      console.log(`    • ${r}`);
    }
  }

  if (result.reasoning.length) {
    console.log("\n  Cited reasoning:");
    for (const r of result.reasoning) {
      console.log(`    • ${r.text}`);
      console.log(`        ↳ source: ${sourceLabel(r.source, kbCache)}`);
    }
  }

  if (result.fhirUsed.length) {
    console.log("\n  FHIR context used:");
    for (const f of result.fhirUsed) console.log(`    • ${f}`);
  }

  console.log(`\n  Disclaimer: ${result.disclaimer}`);
  console.log(
    `  (model: ${result.meta.model} via ${result.meta.provider}, ` +
      `snippets: ${result.meta.retrievedSnippets.join(", ") || "none"})`
  );
  console.log("═".repeat(64) + "\n");

  // Machine-readable strict JSON on stdout as well (single object, last line)
  console.log("STRICT_JSON:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.message.includes("ZAI_API_KEY")) {
    console.error("Copy .env.example to .env and add your Z.AI key.");
  }
  process.exit(1);
});
