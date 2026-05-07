import { PDFParse } from "pdf-parse";

/** Multi-word and single tech terms to detect in resume and job text (lowercase). */
const SKILL_PHRASES = [
  "machine learning",
  "deep learning",
  "artificial intelligence",
  "data science",
  "data scientist",
  "data analyst",
  "predictive model",
  "a/b test",
  "a/b testing",
  "statistical model",
  "causal inference",
  "time series",
  "random forest",
  "gradient boost",
  "logistic regression",
  "linear regression",
  "neural network",
  "natural language",
  "computer vision",
  "scikit-learn",
  "scikit learn",
  "tensorflow",
  "pytorch",
  "keras",
  "xgboost",
  "lightgbm",
  "prophet",
  "arima",
  "clustering",
  "cross-validation",
  "feature engineering",
  "hyperparameter",
  "bayesian",
  "bigquery",
  "google cloud",
  "vertex ai",
  "aws",
  "azure",
  "databricks",
  "apache spark",
  "pyspark",
  "apache airflow",
  "airflow",
  "dbt",
  "etl",
  "elt",
  "data pipeline",
  "dataflow",
  "apache beam",
  "redshift",
  "snowflake",
  "synapse",
  "looker",
  "lookml",
  "tableau",
  "power bi",
  "amplitude",
  "optimizely",
  "experimentation",
  "ab test",
  "sql",
  "pandas",
  "numpy",
  "scipy",
  "matplotlib",
  "seaborn",
  "plotly",
  "r studio",
  "tidyverse",
  "statsmodels",
  "pymc",
  "spark",
  "lambda",
  "s3",
  "kubernetes",
  "docker",
  "mlops",
  "llm",
  "generative ai",
  "langchain",
  "rag",
  "retrieval",
  "vector",
  "embedding",
  "python",
  "sklearn",
];

const STOPWORDS = new Set(
  `a an the and or for to of in on at by as is are was were be been being
  with from that this these those it its we you our their they them my your
  will would can could should may might must have has had do does did doing
  not no but if so than then such also just only very more most some any all
  each every both few other into over out up down about through during before
  after above below between under again further once here there when where why
  how all both each few most other some such own same so than too very just
  and but if or because until while although though resume summary experience
  skills education project projects work company jan feb mar apr may jun jul
  aug sep oct nov dec present phone email address street city state zip
  www com linkedin github http https`
    .split(/\s+/)
    .filter(Boolean)
);

const TITLE_PATTERNS = [
  /(staff|senior|principal|lead|junior|associate)?\s*(data scientist|data science)/i,
  /(machine learning|ml)\s*(engineer|scientist)/i,
  /(data|research)\s*analyst/i,
  /quantitative\s*(analyst|researcher)/i,
  /applied\s*scientist/i,
  /(ai|artificial intelligence)\s*(engineer|scientist)/i,
];

const GENERIC_TITLES = [
  "Data Scientist",
  "Machine Learning Engineer",
  "Data Analyst",
  "Research Scientist",
  "AI Engineer",
];

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function parseResumePdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy();
  }
}

/**
 * JobRight search works better with core role names (without level prefixes).
 * @param {string} title
 * @returns {string}
 */
export function normalizeJobSearchTitle(title) {
  let t = title.trim();
  const level =
    /^(staff|senior|principal|lead|junior|associate|entry[- ]level|mid[- ]level|sr\.?|jr\.?)\s+/i;
  t = t.replace(level, "").trim();
  t = t.replace(/\s+/g, " ");
  return t || title.trim();
}

/**
 * Coarse role family for the user's search chip (used to avoid cross-track noise, e.g. DS vs DE).
 * @param {string} jobTitleInput
 * @returns {"data_science"|"data_engineering"|"data_analytics"|"ml_ai"|"generic"}
 */
export function inferSearchRoleTrack(jobTitleInput) {
  const t = String(jobTitleInput || "")
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (
    /\bdata\s+scientist\b/.test(t) ||
    /\bresearch\s+scientist\b/.test(t) ||
    /\bapplied\s+scientist\b/.test(t)
  ) {
    return "data_science";
  }
  if (
    /\bdata\s+engineer\b/.test(t) ||
    /\bdata\s+platform\b/.test(t) ||
    /\bdata\s+pipeline\b/.test(t) ||
    /\betl\b/.test(t)
  ) {
    return "data_engineering";
  }
  if (/\bmachine\s+learning\b/.test(t) || /\bml\s+engineer\b/.test(t) || /\bai\s+engineer\b/.test(t)) {
    return "ml_ai";
  }
  if (/\bdata\s+analyst\b/.test(t) || /\bbi\s+analyst\b/.test(t) || /\bbusiness\s+analyst\b/.test(t)) {
    return "data_analytics";
  }
  return "generic";
}

/**
 * Drop postings that clearly belong to a different career track than the user's chip.
 * @param {"data_science"|"data_engineering"|"data_analytics"|"ml_ai"|"generic"} track
 * @param {string} postingTitle
 */
export function shouldExcludePostingForSearchTrack(track, postingTitle) {
  if (!track || track === "generic" || !postingTitle) return false;
  const j = String(postingTitle)
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (track === "data_science") {
    if (/\bdata\s+engineer(ing)?\b/.test(j)) return true;
    if (/\bdata\s+engineering\b/.test(j) && !/\bscientist\b/.test(j) && !/\bscience\b/.test(j)) {
      return true;
    }
    return false;
  }

  if (track === "data_engineering") {
    if (/\bdata\s+scientist\b/.test(j) && !/\bengineer\b/.test(j)) return true;
    return false;
  }

  if (track === "ml_ai") {
    if (/\bdata\s+engineer(ing)?\b/.test(j) && !/(machine learning|\bml\b|ai|deep learning)/.test(j)) {
      return true;
    }
    return false;
  }

  return false;
}

/** @param {string} jobSeniority e.g. "Senior Level, Lead/Staff" */
function inferJobPostingSeniorityTier(jobSeniority) {
  const s = String(jobSeniority || "").toLowerCase();
  if (/\bintern\b|\bnew grad\b/.test(s)) return 0;
  if (/\bentry\b/.test(s) && !/\bmid\b/.test(s)) return 1;
  if (/\bmid\b/.test(s) && !/\b(senior|lead|staff|director|executive)\b/.test(s)) return 2;
  if (/\b(senior|sr\.)\b/.test(s) && !/\b(lead|staff|principal|director|executive)\b/.test(s)) return 3;
  if (/\b(lead|staff|principal)\b/.test(s) && !/\b(director|executive)\b/.test(s)) return 4;
  if (/\b(director|executive)\b/.test(s)) return 5;
  if (/\bsenior\b/.test(s)) return 3;
  return 2;
}

function inferResumeSeniorityTier(resumeLower) {
  const r = resumeLower;
  let t = 2;
  if (/\b(intern|internship|new grad|recent graduate)\b/.test(r)) t = Math.min(t, 0);
  if (/\b(principal|distinguished|fellow|director|vice president|vp|head of)\b/.test(r)) {
    t = Math.max(t, 5);
  } else if (/\b(staff|lead technical|tech lead|engineering manager)\b/.test(r)) {
    t = Math.max(t, 4);
  } else if (/\b(senior|sr\.)\b/.test(r)) {
    t = Math.max(t, 3);
  } else if (/\b(junior|jr\.|associate|entry level)\b/.test(r)) {
    t = Math.min(t, 1);
  }
  const yearHits = [...r.matchAll(/\b(\d{1,2})\s*\+?\s*years?\b/g)].map((m) => parseInt(m[1], 10));
  const y = yearHits.length ? Math.max(...yearHits) : 0;
  if (y >= 10) t = Math.max(t, 4);
  else if (y >= 6) t = Math.max(t, 3);
  else if (y >= 3) t = Math.max(t, 2);
  return Math.min(5, Math.max(0, t));
}

/**
 * 0–100 alignment between resume seniority cues and JobRight posting seniority label (ATS-style "level" fit).
 * @param {string} resumeText
 * @param {string | null | undefined} jobSeniority
 */
export function estimateSeniorityAlignmentScore(resumeText, jobSeniority) {
  const r = String(resumeText || "")
    .toLowerCase()
    .replace(/\s+/g, " ");
  const need = inferJobPostingSeniorityTier(jobSeniority);
  const have = inferResumeSeniorityTier(r);
  if (have >= need) {
    const slack = have - need;
    return Math.min(100, Math.round(86 + Math.min(14, slack * 2.5)));
  }
  const gap = need - have;
  return Math.max(22, Math.round(78 - gap * 13));
}

export function inferJobTitleFromResume(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20);

  for (const line of lines) {
    if (/^(skills|experience|education|summary|projects|publications)/i.test(line)) break;
    for (const re of TITLE_PATTERNS) {
      const m = line.match(re);
      if (m) {
        let t = m[0].replace(/\s+/g, " ").trim();
        if (t.length > 3 && t.length < 80) return normalizeTitleCase(t);
      }
    }
  }

  for (const line of lines.slice(0, 8)) {
    const lower = line.toLowerCase();
    for (const g of GENERIC_TITLES) {
      if (lower.includes(g.toLowerCase())) return g;
    }
  }

  return "Data Scientist";
}

function normalizeTitleCase(s) {
  return s
    .split(" ")
    .map((w) =>
      w.length <= 3 && /^(ml|ai|of|in)$/i.test(w)
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(" ")
    .replace(/\bMl\b/g, "ML")
    .replace(/\bAi\b/g, "AI");
}

/**
 * Structured skill phrases found in the resume (aligned with job postings).
 * @param {string} text
 * @returns {string[]}
 */
export function extractResumeSignals(text) {
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  const found = new Set();

  for (const phrase of SKILL_PHRASES) {
    if (lower.includes(phrase)) found.add(phrase);
  }

  const extraSingle = [
    "python",
    "sql",
    "r",
    "pandas",
    "numpy",
    "spark",
    "keras",
    "looker",
    "tableau",
    "snowflake",
    "gcp",
    "saas",
    "ltv",
    "cac",
    "churn",
    "retention",
    "segmentation",
    "forecast",
    "classification",
    "regression",
  ];
  for (const w of extraSingle) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) found.add(w);
  }

  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * Frequent content words from the resume (for description overlap).
 * @param {string} text
 * @param {number} maxTerms
 * @returns {string[]}
 */
export function extractLexicalTerms(text, maxTerms = 90) {
  const raw = text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [];
  const freq = new Map();
  for (let w of raw) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    if (w.length > 24) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([w]) => w);
}

function jobFullCorpusLower(row) {
  const jr = row?.jobResult;
  if (!jr) return "";
  const parts = [
    jr.jobTitle,
    jr.jobNlpTitle,
    jr.jobSummary,
    ...(Array.isArray(jr.requirements) ? jr.requirements : []),
    ...(Array.isArray(jr.coreResponsibilities) ? jr.coreResponsibilities : []),
  ];
  return parts.filter(Boolean).join(" \n ").toLowerCase();
}

function hasAnySkillPhrase(text) {
  return SKILL_PHRASES.some((s) => text.includes(s));
}

export function splitJobSections(row) {
  const jr = row?.jobResult || {};
  const summary = (jr.jobSummary || "").toLowerCase();
  const requirements = Array.isArray(jr.requirements)
    ? jr.requirements.map((x) => String(x || "").toLowerCase()).filter(Boolean)
    : [];
  const responsibilities = Array.isArray(jr.coreResponsibilities)
    ? jr.coreResponsibilities.map((x) => String(x || "").toLowerCase()).filter(Boolean)
    : [];

  const requiredPreferredLines = [];
  const qualificationLines = [];

  for (const line of requirements) {
    const isReqPref =
      /\b(required|preferred|must have|nice to have|minimum|min\.?|at least|\d+\+?\s+years?)\b/i.test(
        line
      );
    const isQual =
      /\b(qualification|qualifications|skill|skills|proficient|knowledge|expertise|experience with|familiarity)\b/i.test(
        line
      ) || hasAnySkillPhrase(line);

    if (isReqPref) requiredPreferredLines.push(line);
    if (isQual || !isReqPref) qualificationLines.push(line);
  }

  const responsibilitiesText = responsibilities.join(" \n ") || summary;
  const qualificationText =
    qualificationLines.join(" \n ") || requirements.join(" \n ") || summary;
  const requiredPreferredText =
    requiredPreferredLines.join(" \n ") || requirements.join(" \n ") || summary;

  return {
    responsibilities: responsibilitiesText,
    qualifications: qualificationText,
    requiredPreferred: requiredPreferredText,
  };
}

function sectionMatchScore(sectionText, resumeSignalsSet, resumeLexicalSet) {
  const text = (sectionText || "").toLowerCase().trim();
  if (!text) return { score: 0, matched: [], phraseCoverage: 0, lexicalCoverage: 0 };

  const jobSignals = SKILL_PHRASES.filter((s) => text.includes(s));
  const matchedPhrases = jobSignals.filter((s) => resumeSignalsSet.has(s));
  const phraseCoverage =
    jobSignals.length > 0 ? matchedPhrases.length / jobSignals.length : 0;

  const jobLexical = extractLexicalTerms(text, 120);
  const lexMatched = jobLexical.filter((t) => resumeLexicalSet.has(t));
  const lexicalCoverage =
    jobLexical.length > 0 ? lexMatched.length / jobLexical.length : 0;

  const overlapBonus = Math.min(
    0.08,
    0.03 * Math.min(1, matchedPhrases.length / 8) +
      0.05 * Math.min(1, lexMatched.length / 16)
  );

  const score = Math.round(
    100 *
      Math.min(1, 0.7 * phraseCoverage + 0.3 * lexicalCoverage + overlapBonus)
  );

  const seen = new Set();
  const matched = [];
  for (const k of [...matchedPhrases, ...lexMatched]) {
    if (seen.has(k)) continue;
    seen.add(k);
    matched.push(k);
    if (matched.length >= 18) break;
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    matched,
    phraseCoverage,
    lexicalCoverage,
  };
}

/**
 * How well the posting title aligns with the user's search chip (normalized).
 * @returns {number} 0–100
 */
function jobTitleSearchAlignment(searchNorm, postingTitle) {
  const q = (searchNorm || "").toLowerCase().trim();
  const j = (postingTitle || "").toLowerCase().trim();
  if (!q || !j) return 72;
  if (j.includes(q) || q.includes(j)) return 100;

  const qa = new Set(q.split(/\s+/).filter((w) => w.length > 2));
  const jb = new Set(j.split(/\s+/).filter((w) => w.length > 2));
  if (qa.size === 0) return 72;
  let overlap = 0;
  for (const t of qa) if (jb.has(t)) overlap += 1;
  const ratio = overlap / qa.size;
  if (ratio >= 0.55) return 96;
  if (ratio >= 0.34) return 78;
  if (ratio > 0) return 52;

  if (/\bdata\s+scientist\b/.test(q) && /\b(scientist|science)\b/.test(j) && /\b(data|research|applied|machine|learning|analytics|ai)\b/.test(j)) {
    return 86;
  }
  if (/\bmachine\s+learning\b/.test(q) || /\bml\b/.test(q)) {
    if (/(machine learning|deep learning|\bml\b|ai engineer|applied scientist)/.test(j)) return 84;
  }
  return 34;
}

/** Strong penalty when the posting is clearly a different professional lane than a technical search. */
function jobTitleOffLaneMultiplier(searchNorm, postingTitle) {
  const q = (searchNorm || "").toLowerCase();
  const j = (postingTitle || "").toLowerCase();
  if (!q) return 1;
  const techSearch =
    /\b(data scientist|data analyst|data engineer|machine learning|research scientist|applied scientist|ml engineer|ai engineer|analytics)\b/.test(
      q
    );
  if (!techSearch) return 1;
  if (
    /\b(product owner|product manager|project manager|program manager|scrum master|delivery manager)\b/.test(
      j
    )
  ) {
    return 0.38;
  }
  if (/\b(recruiter|talent acquisition|sourcer|hr business partner|human resources)\b/.test(j)) {
    return 0.35;
  }
  if (/\b(account executive|sales director|business development|customer success|account manager)\b/.test(j)) {
    return 0.45;
  }
  return 1;
}

/**
 * Score resume ↔ job fit. Emphasizes overlap with the job description (not just the title).
 * @param {string[]} signals - structured phrases from resume
 * @param {object} row - visitor-search jobList item
 * @param {string} resumeText - full resume text
 * @param {string} [searchQueryTitle] - normalized search chip (e.g. from normalizeJobSearchTitle); used to down-rank title/role mismatches
 * @returns {{
 *   score: number,
 *   matchedKeywords: string[],
 *   breakdown: {
 *     responsibilities: number,
 *     qualifications: number,
 *     requiredPreferred: number
 *   }
 * }}
 */
export function scoreJobAgainstResume(signals, row, resumeText, searchQueryTitle = "") {
  const full = jobFullCorpusLower(row);
  if (!full) {
    return {
      score: 0,
      matchedKeywords: [],
      breakdown: { responsibilities: 0, qualifications: 0, requiredPreferred: 0 },
    };
  }

  const sections = splitJobSections(row);
  const resumeSignalsSet = new Set(signals);
  const resumeLexicalSet = new Set(extractLexicalTerms(resumeText, 140));

  const responsibilities = sectionMatchScore(
    sections.responsibilities,
    resumeSignalsSet,
    resumeLexicalSet
  );
  const qualifications = sectionMatchScore(
    sections.qualifications,
    resumeSignalsSet,
    resumeLexicalSet
  );
  const requiredPreferred = sectionMatchScore(
    sections.requiredPreferred,
    resumeSignalsSet,
    resumeLexicalSet
  );

  // Weighted blend + weakest-section floor (similar in spirit to JobRight lowering overall when "Skill" is weak).
  const linear = Math.round(
    0.22 * responsibilities.score +
      0.33 * qualifications.score +
      0.45 * requiredPreferred.score
  );
  const minSec = Math.min(
    responsibilities.score,
    qualifications.score,
    requiredPreferred.score
  );
  // If one section is nearly empty in the API payload, minSec≈0 would crush good roles — ignore floor then.
  let score =
    minSec < 8
      ? linear
      : Math.round(0.72 * linear + 0.28 * minSec);

  const jr = row?.jobResult || {};
  const align = jobTitleSearchAlignment(searchQueryTitle, jr.jobTitle || "");
  const offLane = jobTitleOffLaneMultiplier(searchQueryTitle, jr.jobTitle || "");
  const titleFactor = Math.max(0.35, (0.38 + 0.62 * (align / 100)) * offLane);
  score = Math.round(score * titleFactor);

  const seen = new Set();
  const matchedKeywords = [];
  for (const k of [
    ...requiredPreferred.matched,
    ...qualifications.matched,
    ...responsibilities.matched,
  ]) {
    if (seen.has(k)) continue;
    seen.add(k);
    matchedKeywords.push(k);
    if (matchedKeywords.length >= 22) break;
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    matchedKeywords,
    breakdown: {
      responsibilities: responsibilities.score,
      qualifications: qualifications.score,
      requiredPreferred: requiredPreferred.score,
    },
  };
}
