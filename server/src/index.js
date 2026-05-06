import express from "express";
import cors from "cors";
import multer from "multer";
import "dotenv/config";
import {
  parseResumePdf,
  inferJobTitleFromResume,
  normalizeJobSearchTitle,
  extractResumeSignals,
  scoreJobAgainstResume,
} from "./resume.js";
import { computeSemanticSectionScores, hasSemanticKey } from "./semantic.js";

const PORT = Number(process.env.PORT) || 8787;
const SWAN = "https://swan-api.jobright.ai";
const TIME_WINDOW_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      (file.originalname && file.originalname.toLowerCase().endsWith(".pdf"));
    cb(null, ok);
  },
});

/** @param {string} publishTime e.g. "2026-05-06 04:34:01" */
function parsePublishTime(publishTime) {
  if (!publishTime || typeof publishTime !== "string") return null;
  const isoish = publishTime.replace(" ", "T");
  const d = new Date(isoish);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function getWindowMs(input) {
  if (typeof input !== "string") return null;
  return TIME_WINDOW_MS[input.trim()] ?? null;
}

function compareJobsForDisplay(a, b) {
  const am = a?.matchScore ?? 0;
  const bm = b?.matchScore ?? 0;
  if (am !== bm) return bm - am;

  const ar = a?.sectionScores?.requiredPreferred ?? 0;
  const br = b?.sectionScores?.requiredPreferred ?? 0;
  if (ar !== br) return br - ar;

  const aq = a?.sectionScores?.qualifications ?? 0;
  const bq = b?.sectionScores?.qualifications ?? 0;
  if (aq !== bq) return bq - aq;

  const at = parsePublishTime(a?.publishTime)?.getTime() ?? 0;
  const bt = parsePublishTime(b?.publishTime)?.getTime() ?? 0;
  return bt - at;
}

function isOlderThan(a, b) {
  const at = parsePublishTime(a?.publishTime)?.getTime();
  const bt = parsePublishTime(b?.publishTime)?.getTime();
  if (at == null && bt == null) return false;
  if (at == null) return false;
  if (bt == null) return true;
  return at < bt;
}

/**
 * Deduplicate by (company + job title) over a 7-day pool.
 * Keeps only the best-ranked job for each pair.
 * @param {Array<any>} jobs
 */
function dedupeByCompanyAndTitleKeepOldest(jobs) {
  const bestByPair = new Map();
  const noPairKey = [];

  for (const job of jobs) {
    const companyRaw =
      typeof job?.companyName === "string" ? job.companyName.trim() : "";
    const titleRaw =
      typeof job?.jobTitle === "string" ? job.jobTitle.trim() : "";
    const company = companyRaw.toLowerCase().replace(/\s+/g, " ");
    const title = titleRaw.toLowerCase().replace(/\s+/g, " ");
    const key = company && title ? `${company}|||${title}` : "";

    if (!key) {
      noPairKey.push(job);
      continue;
    }

    const prev = bestByPair.get(key);
    // De-dup rule: keep the oldest posting for the same (company + title).
    if (!prev || isOlderThan(job, prev)) {
      bestByPair.set(key, job);
    }
  }

  return [...bestByPair.values(), ...noPairKey].sort(compareJobsForDisplay);
}

/**
 * Keep only jobs newer than selected window cutoff.
 * @param {Array<any>} jobs
 * @param {"24h"|"3d"|"7d"} timeWindow
 */
function filterJobsBySelectedWindow(jobs, timeWindow) {
  const windowMs = getWindowMs(timeWindow);
  if (!windowMs) return jobs;
  const cutoffTs = Date.now() - windowMs;
  return jobs.filter((j) => {
    const t = parsePublishTime(j?.publishTime);
    return t ? t.getTime() >= cutoffTs : false;
  });
}

function buildSearchBody(jobTitle) {
  const t = jobTitle.trim();
  return {
    searchType: "job_title",
    value: t,
    lite: false,
    jobTaxonomyList: [{ taxonomyId: "00-00-00", title: t }],
    country: "US",
    jobTypes: [],
    seniority: [],
    workModel: [],
    locations: [],
    companies: [],
    daysAgo: null,
    isH1BOnly: false,
    companyCategory: null,
    annualSalaryMinimum: null,
    roleType: null,
    companyStages: null,
    skills: [],
    excludedCompanies: [],
    excludedSkills: null,
    excludeStaffingAgency: false,
    minYearsOfExperienceRange: null,
    excludeCompanyCategory: [],
    excludeSecurityClearance: false,
    excludeUsCitizen: false,
  };
}

async function fetchVisitorSearchPage(body, position, count = 20) {
  const qs = new URLSearchParams({
    lite: "false",
    count: String(count),
    position: String(position),
    searchType: "job-title",
    sortCondition: "1",
  });
  const url = `${SWAN}/swan/recommend/visitor-search?${qs}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (compatible; JobRightDaySearch/1.0; +https://jobright.ai)",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`JobRight API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || !json.success) {
    const msg = json.errorMsg || json.message || text.slice(0, 200);
    throw new Error(`JobRight API error (${res.status}): ${msg}`);
  }
  return json.result;
}

/**
 * Walk freshest-first pages and keep only jobs newer than cutoff.
 * @param {string} jobTitle
 * @param {"24h"|"3d"|"7d"} timeWindow
 * @param {{ keepDetail?: boolean }} [options]
 */
async function collectJobsForWindow(jobTitle, timeWindow, options = {}) {
  const { keepDetail = false } = options;
  const windowMs = getWindowMs(timeWindow);
  if (!windowMs) throw new Error("Invalid timeWindow.");

  const cutoffTs = Date.now() - windowMs;
  const body = buildSearchBody(jobTitle);
  const out = [];
  const pageSize = 20;
  const maxPages = 60;
  let position = 0;
  let shouldStop = false;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let page = 0; page < maxPages && !shouldStop; page++) {
    if (page > 0) await delay(150);
    const result = await fetchVisitorSearchPage(body, position, pageSize);
    const list = result?.jobList;
    if (!Array.isArray(list) || list.length === 0) break;

    for (const row of list) {
      const jr = row?.jobResult;
      if (!jr?.jobId || !jr.publishTime) continue;
      const t = parsePublishTime(jr.publishTime);
      if (!t) continue;

      if (t.getTime() >= cutoffTs) {
        const url = `https://jobright.ai/jobs/info/${jr.jobId}`;
        const item = {
          jobId: jr.jobId,
          url,
          jobTitle: jr.jobTitle,
          publishTime: jr.publishTime,
          companyName: row?.companyResult?.companyName ?? null,
        };
        if (keepDetail) item._row = row;
        out.push(item);
      } else {
        shouldStop = true;
      }
    }

    const last = list[list.length - 1]?.jobResult?.publishTime;
    const lastTime = parsePublishTime(last);
    if (lastTime && lastTime.getTime() < cutoffTs) shouldStop = true;

    position += pageSize;
  }

  return out;
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/jobs-by-day", async (req, res) => {
  const jobTitle = req.body?.jobTitle ?? req.body?.title;
  const timeWindow = req.body?.timeWindow;

  if (typeof jobTitle !== "string" || !jobTitle.trim()) {
    res.status(400).json({ error: "jobTitle is required (non-empty string)." });
    return;
  }
  if (!getWindowMs(timeWindow)) {
    res.status(400).json({
      error: "timeWindow is required: 24h, 3d, or 7d.",
    });
    return;
  }

  try {
    // For non-resume endpoint, keep selected-window behavior with no cross-window dedupe.
    const jobs = await collectJobsForWindow(jobTitle.trim(), timeWindow.trim());
    res.json({
      jobTitle: jobTitle.trim(),
      timeWindow: timeWindow.trim(),
      count: jobs.length,
      totalBeforeCompanyDedup: jobs.length,
      totalAfterCompanyDedup: jobs.length,
      jobs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(502).json({ error: msg });
  }
});

app.post(
  "/api/jobs-from-resume",
  upload.single("resume"),
  async (req, res) => {
    const timeWindow = req.body?.timeWindow;
    const jobTitleInput =
      typeof req.body?.jobTitle === "string" ? req.body.jobTitle.trim() : "";

    if (!req.file?.buffer) {
      res.status(400).json({ error: "Upload a PDF resume (field name: resume)." });
      return;
    }
    if (!jobTitleInput) {
      res.status(400).json({
        error:
          "jobTitle is required: enter the role to search (e.g. Data Scientist, Machine Learning Engineer).",
      });
      return;
    }
    if (!getWindowMs(timeWindow)) {
      res.status(400).json({
        error: "timeWindow is required: 24h, 3d, or 7d.",
      });
      return;
    }

    try {
      const resumeText = await parseResumePdf(req.file.buffer);
      if (!resumeText || resumeText.trim().length < 40) {
        res.status(400).json({
          error: "Could not read enough text from the PDF. Try another file or a text-based PDF.",
        });
        return;
      }

      const searchTitle = normalizeJobSearchTitle(jobTitleInput);
      const resumeHeadline = inferJobTitleFromResume(resumeText);
      const signals = extractResumeSignals(resumeText);

      // Always collect 7 days for de-duplication, regardless of selected display window.
      const rawJobs = await collectJobsForWindow(searchTitle, "7d", {
        keepDetail: true,
      });

      const textScored = rawJobs
        .map((j) => {
          const row = j._row;
          const { _row, ...rest } = j;
          const { score, matchedKeywords, breakdown } = scoreJobAgainstResume(
            signals,
            row,
            resumeText
          );
          return {
            ...rest,
            matchScore: score,
            sectionScores: breakdown,
            textScore: score,
            textSectionScores: breakdown,
            matchedKeywords,
          };
        })
        .sort((a, b) => b.matchScore - a.matchScore);

      let semanticMap = new Map();
      let semanticUsed = false;
      try {
        semanticMap = await computeSemanticSectionScores(rawJobs, resumeText);
        semanticUsed = hasSemanticKey() && semanticMap.size > 0;
      } catch {
        semanticMap = new Map();
        semanticUsed = false;
      }

      const jobs = textScored
        .map((j) => {
          const sem = semanticMap.get(j.jobId);
          if (!sem) return j;
          return {
            ...j,
            matchScore: sem.final,
            sectionScores: {
              responsibilities: sem.responsibilities,
              qualifications: sem.qualifications,
              requiredPreferred: sem.requiredPreferred,
            },
          };
        })
        .sort((a, b) => b.matchScore - a.matchScore);

      const dedupedJobs = dedupeByCompanyAndTitleKeepOldest(jobs);
      const jobsInSelectedWindow = filterJobsBySelectedWindow(
        dedupedJobs,
        timeWindow.trim()
      );

      res.json({
        jobTitleInput,
        searchTitle,
        resumeHeadline,
        timeWindow: timeWindow.trim(),
        resumeSignals: signals,
        resumePreview: resumeText.slice(0, 320).replace(/\s+/g, " ").trim(),
        semanticUsed,
        count: jobsInSelectedWindow.length,
        companyTitleDedupWindow: "7d",
        totalBeforeCompanyDedup: jobs.length,
        totalAfterCompanyDedup: dedupedJobs.length,
        jobs: jobsInSelectedWindow,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: msg });
    }
  }
);

app.listen(PORT, () => {
  console.log(`jobright-tool server http://localhost:${PORT}`);
});
