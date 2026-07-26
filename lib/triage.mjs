// The clinical triage agent.
//
// Pipeline:  symptom  ->  read FHIR context  ->  retrieve guideline snippets
//            ->  build cited, safety-routed prompt  ->  GLM-5.2 (Z.AI)
//            ->  parse + validate  ->  apply the FROZEN safety node
//            ->  strict-JSON result.
//
// The frozen safety node (lib/redflags.mjs) is deterministic code that runs
// AROUND the model call: it informs the prompt AND can override the model's
// triage to EMERGENCY. It is the "frozen rule the optimizer cannot relax."

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { retrieve, getKbEntry, getAllSources } from "./retrieve.mjs";
import { detectRedFlags } from "./redflags.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TRIAGE_LEVELS = ["EMERGENCY", "URGENT_CARE", "ROUTINE", "SELF_CARE"];

const ZAI_ENDPOINT =
  process.env.ZAI_ENDPOINT ||
  "https://api.z.ai/api/coding/paas/v4/chat/completions";
const ZAI_MODEL = process.env.ZAI_MODEL || "glm-5.2";

// ---------------------------------------------------------------------------
// FHIR context
// ---------------------------------------------------------------------------

export function loadFhirBundle(path) {
  const file = path || join(__dirname, "..", "fhir", "sample-patient.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;
  const diff = Date.now() - birth.getTime();
  return Math.floor(diff / (365.25 * 24 * 3600 * 1000));
}

// Compact, structured view of the bundle the agent (and the UI) can reason over.
export function summarizeFhir(bundle) {
  const entries = (bundle?.entry ?? []).map((e) => e.resource).filter(Boolean);
  const patient = entries.find((r) => r.resourceType === "Patient");
  const conditions = entries.filter(
    (r) =>
      r.resourceType === "Condition" &&
      r.clinicalStatus?.coding?.some((c) => c.code === "active")
  );
  const allergies = entries.filter((r) => r.resourceType === "AllergyIntolerance");
  const observations = entries.filter((r) => r.resourceType === "Observation");

  const nameObj = patient?.name?.[0] ?? {};
  const name = [nameObj.given?.flat?.(), nameObj.family]
    .filter(Boolean)
    .flat()
    .join(" ")
    .trim();

  const conditionLines = conditions.map((c) => {
    const code = c.code?.coding?.[0];
    return `- ${code?.display || c.code?.text || "unspecified"} (ICD-10 ${
      code?.code || "?"
    })`;
  });

  const allergyLines = allergies.map((a) => {
    const code = a.code?.coding?.[0];
    return `- ${code?.display || a.code?.text || "allergy"} (criticality: ${
      a.criticality || "unknown"
    })`;
  });

  const obsLines = observations.map((o) => {
    const display = o.code?.coding?.[0]?.display || o.code?.text || o.id;
    const v = o.valueQuantity;
    const comps = o.component;
    if (v) {
      return `- ${display}: ${v.value} ${v.unit}`.trim();
    }
    if (comps?.length) {
      const parts = comps.map((c) => {
        const d = c.code?.coding?.[0]?.display || "value";
        return `${d.split(" ")[0].toLowerCase()} ${c.valueQuantity?.value}`;
      });
      return `- ${display}: ${parts.join(" / ")}`;
    }
    return `- ${display}: (no value)`;
  });

  const summary = [
    `Patient: ${name || "Unknown"} — ${
      patient?.gender || "gender unknown"
    }, age ${ageFromBirthDate(patient?.birthDate) ?? "unknown"} (DOB ${
      patient?.birthDate || "?"
    }).`,
    conditionLines.length ? "Active conditions:" : "Active conditions: none.",
    ...conditionLines,
    allergyLines.length ? "Allergies:" : "Allergies: none.",
    ...allergyLines,
    "Recent observations / labs:",
    ...obsLines,
  ].join("\n");

  return {
    summary,
    structured: {
      name: name || "Unknown",
      age: ageFromBirthDate(patient?.birthDate),
      gender: patient?.gender || null,
      conditions: conditions.map((c) => ({
        display: c.code?.coding?.[0]?.display || c.code?.text,
        icd10: c.code?.coding?.[0]?.code,
      })),
      allergies: allergies.map((a) => ({
        display: a.code?.coding?.[0]?.display || a.code?.text,
        criticality: a.criticality,
      })),
      observations: observations.map((o) => ({
        display: o.code?.coding?.[0]?.display || o.code?.text,
        value: o.valueQuantity
          ? `${o.valueQuantity.value} ${o.valueQuantity.unit}`.trim()
          : o.component?.length
            ? o.component.map((c) => c.valueQuantity?.value).join(" / ")
            : null,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPrompt({ symptom, fhirSummary, snippets, redFlagScan }) {
  const snippetsBlock = snippets
    .map((s) => {
      const entry = getKbEntry(s.id);
      if (!entry) return null;
      return `  [id: ${entry.id}] (${entry.source})\n    ${entry.text}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const safetyDirective = redFlagScan.forceEmergency
    ? `DETERMINISTIC SAFETY SCAN (frozen node) has flagged emergency red-flags:\n${redFlagScan.matched
        .map((m) => `  - ${m.label}`)
        .join(
          "\n"
        )}\nYou MUST set "triage" to "EMERGENCY", list each in "redFlags", refuse to diagnose, and include the escalation instruction "${redFlagScan.escalation}".`
    : `DETERMINISTIC SAFETY SCAN (frozen node): no automatic emergency red-flag matched. Still apply your own clinical judgement for any red-flags the pattern scan may have missed.`;

  const system = `You are a clinical TRIAGE assistant, NOT a diagnostician.

Hard rules:
1. NEVER give a definitive diagnosis. Always recommend evaluation by a qualified clinician. You may describe what to evaluate for and how urgent it is, but you do not conclude a diagnosis.
2. Triage level MUST be exactly one of: EMERGENCY, URGENT_CARE, ROUTINE, SELF_CARE.
3. If any emergency red-flag is present (e.g. chest pain, stroke signs, anaphylaxis, severe shortness of breath, suicidal ideation, GI bleed, sepsis signs), set "triage" to "EMERGENCY", refuse to diagnose, and include an explicit escalation instruction (e.g. "Call 911 / emergency services now").
4. Every clinical statement in "reasoning" MUST cite a source id drawn from the "Guideline snippets" provided below. The source id is the bracketed value, e.g. "acs-chest-pain". If you cannot cite one of those exact ids, set "source" to "no source" and explicitly defer to a clinician.
5. Reason conservatively in favour of patient safety when uncertain.
6. Output ONLY a single JSON object — no prose before or after, no markdown fences, no comments — that exactly matches this schema:
{
  "triage": "EMERGENCY | URGENT_CARE | ROUTINE | SELF_CARE",
  "redFlags": ["string", "..."],
  "reasoning": [ { "text": "string", "source": "<one of the provided snippet ids, or 'no source'>" } ],
  "fhirUsed": ["short description of which FHIR context items informed the triage"],
  "disclaimer": "one short sentence reminding the user this is not a diagnosis and to seek clinical evaluation"
}`;

  const user = `Chief complaint (free text from the user):
"""
${symptom}
"""

Patient context (FHIR R4, synthetic):
${fhirSummary}

Guideline snippets available for citation:
${snippetsBlock || "  (none retrieved)"}

${safetyDirective}

Triage this complaint now. Remember: strict JSON only, cite real snippet ids, never diagnose.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// GLM-5.2 call
// ---------------------------------------------------------------------------

async function callGlm(system, user) {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ZAI_API_KEY is not set. Copy .env.example to .env and add your Z.AI key."
    );
  }

  const body = {
    model: ZAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // GLM-5.2 emits reasoning_content before the final answer, and
    // completion_tokens includes reasoning tokens. Budget generously.
    max_tokens: 4096,
    temperature: 0.2,
  };

  const res = await fetch(ZAI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Z.AI request failed (${res.status} ${res.statusText}): ${detail.slice(
        0,
        500
      )}`
    );
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Z.AI returned an empty content field.");
  }
  return content;
}

// ---------------------------------------------------------------------------
// Parsing + validation + frozen-safety enforcement
// ---------------------------------------------------------------------------

function stripFences(text) {
  let t = String(text).trim();
  // Remove a single surrounding ```json ... ``` or ``` ... ``` fence.
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // If the model still wrapped with stray prose, isolate the first {...} block.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    t = t.slice(first, last + 1);
  }
  return t.trim();
}

function coerceResult(raw) {
  const out = {
    triage: "ROUTINE",
    redFlags: [],
    reasoning: [],
    fhirUsed: [],
    disclaimer:
      "This tool is a demo and does not provide a diagnosis. Please consult a qualified clinician.",
  };
  if (!raw || typeof raw !== "object") return out;

  if (TRIAGE_LEVELS.includes(raw.triage)) out.triage = raw.triage;

  if (Array.isArray(raw.redFlags)) {
    out.redFlags = raw.redFlags
      .filter((r) => typeof r === "string" && r.trim())
      .map((r) => r.trim());
  }

  if (Array.isArray(raw.reasoning)) {
    const validSources = new Set(getAllSources().map((s) => s.id));
    out.reasoning = raw.reasoning
      .filter((r) => r && typeof r === "object")
      .map((r) => {
        const text = String(r.text ?? "").trim();
        if (!text) return null;
        const src = String(r.source ?? "").trim();
        const source =
          src && validSources.has(src) ? src : "no source";
        return { text, source };
      })
      .filter(Boolean);
  }

  if (Array.isArray(raw.fhirUsed)) {
    out.fhirUsed = raw.fhirUsed
      .filter((r) => typeof r === "string" && r.trim())
      .map((r) => r.trim());
  }

  if (typeof raw.disclaimer === "string" && raw.disclaimer.trim()) {
    out.disclaimer = raw.disclaimer.trim();
  }

  return out;
}

function applyFrozenSafety(result, redFlagScan) {
  if (!redFlagScan.forceEmergency) return result;

  const out = { ...result, triage: "EMERGENCY" };

  // Make sure every deterministic red-flag is represented.
  for (const m of redFlagScan.matched) {
    if (!out.redFlags.some((r) => r.toLowerCase().includes(m.label.toLowerCase()))) {
      out.redFlags.unshift(m.label);
    }
  }

  // Guarantee an explicit, human-readable escalation line at the top.
  const escalation = redFlagScan.escalation;
  if (!out.redFlags.includes(escalation)) {
    out.redFlags.unshift(escalation);
  }

  // Strip any definitive-diagnosis phrasing the model may have produced, and
  // always append a deferral. We never let the model land a diagnosis.
  const definitive = /\b(you have|diagnosis is|confirmed|definitely)\b/i;
  out.reasoning = out.reasoning.map((r) =>
    definitive.test(r.text)
      ? { ...r, text: r.text.replace(definitive, "this may be") }
      : r
  );
  out.reasoning.push({
    text: "Definitive diagnosis is deferred — this requires in-person evaluation by a clinician. Do not delay emergency care to seek a diagnosis.",
    source: "no source",
  });

  // The escalation must be reflected in the disclaimer too.
  out.disclaimer =
    "Possible medical emergency — this is not a diagnosis. Call emergency services (911) now and seek in-person clinical evaluation.";

  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function triage({ symptom, fhirPath }) {
  const complaint = String(symptom ?? "").trim();
  if (!complaint) {
    throw new Error("No symptom/complaint provided.");
  }

  const bundle = loadFhirBundle(fhirPath);
  const { summary: fhirSummary, structured: fhirStructured } =
    summarizeFhir(bundle);

  const hits = retrieve(complaint, 6);
  const snippets = hits.map((h) => ({ id: h.id }));

  // Frozen safety node — runs BEFORE the model so the prompt can honor it.
  const redFlagScan = detectRedFlags(complaint);

  const { system, user } = buildPrompt({
    symptom: complaint,
    fhirSummary,
    snippets,
    redFlagScan,
  });

  let modelError = null;
  let result = {
    triage: "ROUTINE",
    redFlags: [],
    reasoning: [
      {
        text: "The model could not be reached; returning a safe fallback. Please retry.",
        source: "no source",
      },
    ],
    fhirUsed: [],
    disclaimer:
      "This tool is a demo and does not provide a diagnosis. Please consult a qualified clinician.",
  };

  try {
    const content = await callGlm(system, user);
    const parsed = JSON.parse(stripFences(content));
    result = coerceResult(parsed);
  } catch (err) {
    modelError = err.message;
  }

  // Frozen safety node — runs AGAIN, AFTER the model, and overrides the model
  // if it under-triaged a flagged emergency. The optimizer cannot relax this.
  const final = applyFrozenSafety(result, redFlagScan);

  return {
    ...final,
    meta: {
      model: ZAI_MODEL,
      provider: "Z.AI",
      retrievedSnippets: snippets.map((s) => s.id),
      fhirUsedStructured: fhirStructured,
      safetyFlags: redFlagScan.matched.map((m) => m.id),
      frozenSafetyEngaged: redFlagScan.forceEmergency,
      modelError,
    },
  };
}
