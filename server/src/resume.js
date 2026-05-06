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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Job posting text most relevant to “fit”: summary, requirements, responsibilities. */
function jobDescriptionCorpusLower(row) {
  const jr = row?.jobResult;
  if (!jr) return "";
  const parts = [
    jr.jobSummary,
    ...(Array.isArray(jr.requirements) ? jr.requirements : []),
    ...(Array.isArray(jr.coreResponsibilities) ? jr.coreResponsibilities : []),
  ];
  return parts.filter(Boolean).join(" \n ").toLowerCase();
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

/**
 * Score resume ↔ job fit. Emphasizes overlap with the job description (not just the title).
 * @param {string[]} signals - structured phrases from resume
 * @param {object} row - visitor-search jobList item
 * @param {string} resumeText - full resume text
 * @returns {{ score: number, matchedKeywords: string[] }}
 */
export function scoreJobAgainstResume(signals, row, resumeText) {
  const jdRaw = jobDescriptionCorpusLower(row);
  const full = jobFullCorpusLower(row);
  const jd = jdRaw || full;
  if (!jd && !full) return { score: 0, matchedKeywords: [] };

  const lexical = extractLexicalTerms(resumeText, 100);
  const matchedPhrases = [];
  let phrasesInJd = 0;

  for (const s of signals) {
    if (!full.includes(s)) continue;
    matchedPhrases.push(s);
    const inDescription = jdRaw ? jdRaw.includes(s) : jd.includes(s);
    if (inDescription) phrasesInJd++;
  }

  const lexMatched = [];
  const jdForWord = jd;
  for (const term of lexical) {
    try {
      const re = new RegExp(`\\b${escapeRe(term)}\\b`, "i");
      if (re.test(jdForWord)) lexMatched.push(term);
    } catch {
      /* ignore bad regex */
    }
  }

  const denomPhrases = Math.max(signals.length, 10);
  const phraseJdRatio = phrasesInJd / denomPhrases;
  const phraseAnyRatio = matchedPhrases.length / denomPhrases;

  const denomLex = Math.max(lexical.length, 20);
  const lexRatio = lexMatched.length / denomLex;

  let score;
  if (signals.length === 0) {
    score = Math.min(100, Math.round(100 * Math.min(1, (lexRatio * 1.15 + lexMatched.length / 35) / 1.15)));
  } else {
    score = Math.round(
      100 *
        Math.min(
          1,
          0.52 * phraseJdRatio +
            0.18 * phraseAnyRatio +
            0.28 * Math.min(1, lexRatio * 1.25) +
            0.02 * Math.min(1, matchedPhrases.length / 12)
        )
    );
  }

  const seen = new Set();
  const matchedKeywords = [];
  for (const k of [...matchedPhrases, ...lexMatched]) {
    if (seen.has(k)) continue;
    seen.add(k);
    matchedKeywords.push(k);
    if (matchedKeywords.length >= 22) break;
  }

  return { score: Math.min(100, Math.max(0, score)), matchedKeywords };
}
