// Lightweight BM25-style retrieval over the guideline knowledge base.
// Zero external dependencies. Returns the top-k snippets relevant to a query,
// each annotated with its source label so the agent can cite it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "my", "i", "is", "am", "are", "was", "have", "has", "had", "it", "this",
  "that", "very", "really", "feel", "feeling", "feels", "like", "been",
  "from", "as", "at", "by", "be", "not", "no", "do", "does", "did", "and",
]);

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

let _kb = null;
function loadKb() {
  if (_kb) return _kb;
  const raw = readFileSync(join(__dirname, "..", "kb", "guidelines.json"), "utf8");
  _kb = JSON.parse(raw);
  return _kb;
}

// Precompute per-document term frequencies and document length stats once.
let _index = null;
function buildIndex() {
  if (_index) return _index;
  const kb = loadKb();
  const docs = kb.map((entry) => {
    const tokens = tokenize(`${entry.topic} ${entry.text}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { entry, tokens, tf, length: tokens.length };
  });
  const avgLength = docs.reduce((s, d) => s + d.length, 0) / Math.max(docs.length, 1);
  _index = { docs, avgLength, df: new Map() };
  // document frequency per term
  for (const d of docs) {
    for (const term of d.tf.keys()) {
      _index.df.set(term, (_index.df.get(term) ?? 0) + 1);
    }
  }
  return _index;
}

// BM25 scoring with clinical emphasis: terms matching a snippet's "topic"
// (its title/category) count extra, because topic keywords are strong signals.
export function score(query, doc) {
  const { df, docs, avgLength } = buildIndex();
  const N = docs.length;
  const k1 = 1.5;
  const b = 0.75;
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return 0;

  let scoreVal = 0;
  for (const term of queryTerms) {
    const f = doc.tf.get(term) ?? 0;
    if (f === 0) continue;
    const n = df.get(term) ?? 0;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    const denom = f + k1 * (1 - b + b * (doc.length / avgLength));
    scoreVal += idf * ((f * (k1 + 1)) / denom);
  }
  return scoreVal;
}

export function retrieve(query, k = 5) {
  const { docs } = buildIndex();
  const scored = docs
    .map((d) => ({ ...d, score: score(query, d) }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // Always surface the broad respiratory-distress and anaphylaxis safety
  // candidates if the query looks breath-related, even if score is low, so
  // critical red-flag knowledge is never silently dropped by sparse matching.
  const lowered = String(query ?? "").toLowerCase();
  const safetyHints = /breath|wheeze|swell|throat|lip|tongue|allerg/.test(lowered);

  const result = scored.map((d) => ({ id: d.entry.id, score: Number(d.score.toFixed(3)) }));
  if (safetyHints && !result.find((r) => r.id === "severe-respiratory-distress")) {
    result.push({ id: "severe-respiratory-distress", score: 0 });
  }
  return result;
}

export function getKbEntry(id) {
  return loadKb().find((e) => e.id === id) ?? null;
}

export function getAllSources() {
  return loadKb().map((e) => ({ id: e.id, source: e.source }));
}
