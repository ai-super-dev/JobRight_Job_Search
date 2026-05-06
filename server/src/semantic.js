import OpenAI from "openai";
import { splitJobSections } from "./resume.js";

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function toPercentFromCosine(cos) {
  // cosine [-1,1] -> [0,100]
  return Math.round(clamp01((cos + 1) / 2) * 100);
}

export function hasSemanticKey() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
}

/**
 * Semantic score for each job across 3 JobRight sections.
 * @param {Array<{jobId: string, _row: any}>} rawJobs
 * @param {string} resumeText
 * @returns {Promise<Map<string, { responsibilities: number, qualifications: number, requiredPreferred: number, final: number }>>}
 */
export async function computeSemanticSectionScores(rawJobs, resumeText) {
  if (!hasSemanticKey() || !Array.isArray(rawJobs) || rawJobs.length === 0) {
    return new Map();
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  /** @type {string[]} */
  const texts = [resumeText];
  /** @type {Array<{jobId: string, section: "responsibilities"|"qualifications"|"requiredPreferred"}>} */
  const index = [];

  for (const j of rawJobs) {
    const sections = splitJobSections(j._row);
    for (const section of [
      "responsibilities",
      "qualifications",
      "requiredPreferred",
    ]) {
      texts.push(sections[section] || "");
      index.push({ jobId: j.jobId, section });
    }
  }

  const emb = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });

  const vectors = emb.data.map((d) => d.embedding);
  const resumeVec = vectors[0];

  const byJob = new Map();
  for (let i = 0; i < index.length; i++) {
    const meta = index[i];
    const secVec = vectors[i + 1];
    const pct = toPercentFromCosine(cosineSimilarity(resumeVec, secVec));
    if (!byJob.has(meta.jobId)) {
      byJob.set(meta.jobId, {
        responsibilities: 0,
        qualifications: 0,
        requiredPreferred: 0,
      });
    }
    byJob.get(meta.jobId)[meta.section] = pct;
  }

  const out = new Map();
  for (const [jobId, s] of byJob.entries()) {
    const final = Math.round(
      0.2 * s.responsibilities + 0.35 * s.qualifications + 0.45 * s.requiredPreferred
    );
    out.set(jobId, { ...s, final });
  }
  return out;
}

