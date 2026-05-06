import OpenAI from "openai";
import {
  splitJobSections,
  normalizeJobSearchTitle,
  inferSearchRoleTrack,
} from "./resume.js";

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

function dedupeTitleQueries(list) {
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const s = String(t || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!s || s.length > 90) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** Remove JobRight query strings that belong to another track than the user's chip. */
function filterExpandedQueriesByTrack(track, queries) {
  if (track === "data_science") {
    return queries.filter((q) => {
      const s = q.toLowerCase();
      if (/\bdata\s+engineer(ing)?\b/.test(s)) return false;
      if (/\bdata\s+engineering\b/.test(s) && !/\bscientist\b/.test(s)) return false;
      if (/\bdata\s+platform\b/.test(s)) return false;
      if (/\betl\b/.test(s)) return false;
      return true;
    });
  }
  if (track === "data_engineering") {
    return queries.filter((q) => {
      const s = q.toLowerCase();
      if (/\bdata\s+scientist\b/.test(s) && !/\bengineer\b/.test(s)) return false;
      return true;
    });
  }
  if (track === "ml_ai") {
    return queries.filter((q) => {
      const s = q.toLowerCase();
      if (/\bdata\s+engineer(ing)?\b/.test(s) && !/(machine learning|\bml\b|\bai\b)/.test(s)) {
        return false;
      }
      return true;
    });
  }
  return queries;
}

/**
 * Expand one user-facing role into several JobRight-style job_title search strings
 * (synonyms, spelled-out abbreviations, adjacent titles), using resume context when present.
 * Falls back to the normalized title only when no API key or the model call fails.
 *
 * @param {string} jobTitleInput
 * @param {string} resumeText
 * @returns {Promise<{ queries: string[], usedLlm: boolean }>}
 */
export async function expandJobSearchQueries(jobTitleInput, resumeText) {
  const trimmed = jobTitleInput.trim().replace(/\s+/g, " ");
  const primaryNorm = normalizeJobSearchTitle(trimmed) || trimmed;
  const roleTrack = inferSearchRoleTrack(trimmed);
  let baseline = dedupeTitleQueries([trimmed, primaryNorm].filter(Boolean));
  baseline = filterExpandedQueriesByTrack(roleTrack, baseline);

  if (!hasSemanticKey() || !trimmed) {
    return {
      queries: baseline.length ? baseline : [trimmed || "professional"],
      usedLlm: false,
      roleTrack,
    };
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const resumeSnip = (resumeText || "")
      .slice(0, 4500)
      .replace(/\s+/g, " ")
      .trim();

    const trackRules =
      roleTrack === "data_science"
        ? [
            `TRACK: Data science / analytics modeling (scientist, applied scientist, research scientist, quantitative researcher).`,
            `Do NOT output titles that are primarily data engineering / data platform / ETL / pipelines (e.g. "Data Engineer", "Analytics Engineer" when it means infra).`,
            `You MAY include Machine Learning Scientist / ML Scientist overlaps; avoid pure "Data Engineer" strings.`,
          ].join(" ")
        : roleTrack === "data_engineering"
          ? [
              `TRACK: Data engineering / platform / pipelines.`,
              `Do NOT output pure "Data Scientist" titles unless the role is explicitly hybrid engineering+modeling.`,
            ].join(" ")
          : roleTrack === "ml_ai"
            ? [
                `TRACK: Machine learning / AI engineering.`,
                `Prefer ML/AI engineer, applied ML, research engineer (ML) style titles; avoid unrelated pure data analyst or pure data platform titles.`,
              ].join(" ")
            : [
                `Stay in the same professional lane as the primary role (analytics vs science vs engineering vs ML).`,
                `Do not mix incompatible lanes (e.g. data scientist search should not become data engineer job searches).`,
              ].join(" ");

    const userMsg = [
      `The job board search API matches SHORT job-title style strings (like LinkedIn role names), not full job descriptions.`,
      `Primary role the user wants to find: "${trimmed}".`,
      trackRules,
      resumeSnip
        ? `Resume excerpt (use only to add titles in the SAME lane the candidate would apply to; do not invent employers):\n${resumeSnip}`
        : "No resume excerpt; infer related titles only from the primary role and track rules.",
      ``,
      `Return strict JSON with shape: {"titles": string[]}`,
      `Include 5–10 DISTINCT titles, ordered closest-first.`,
      `Cover: exact wording, common abbreviations spelled out (ML → Machine Learning), and close synonyms within the SAME track only.`,
      `Each title under 80 characters, no explanations inside strings.`,
    ].join("\n");

    const model = process.env.OPENAI_TITLE_MODEL || "gpt-4o-mini";
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.35,
      max_tokens: 650,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You only reply with valid JSON: {"titles": string[]}. No markdown, no prose outside JSON. Respect the user track: do not suggest job titles from a different career track (e.g. never suggest Data Engineer titles for a Data Scientist-only search).',
        },
        { role: "user", content: userMsg },
      ],
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed.titles) ? parsed.titles : [];
    const cleaned = arr
      .map((t) => String(t || "").trim().replace(/\s+/g, " "))
      .filter((t) => t.length >= 2 && t.length <= 80);

    let merged = dedupeTitleQueries([...baseline, ...cleaned]).slice(0, 10);
    merged = filterExpandedQueriesByTrack(roleTrack, merged);
    const queries = merged.length ? merged : baseline.length ? baseline : [trimmed];
    return { queries, usedLlm: true, roleTrack };
  } catch {
    return {
      queries: baseline.length ? baseline : [trimmed],
      usedLlm: false,
      roleTrack,
    };
  }
}

