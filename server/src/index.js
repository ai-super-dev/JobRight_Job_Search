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
  inferSearchRoleTrack,
  shouldExcludePostingForSearchTrack,
} from "./resume.js";
import {
  computeSemanticAtsMatchScores,
  computeSemanticSectionScores,
  expandJobSearchQueries,
  hasSemanticKey,
} from "./semantic.js";

const PORT = Number(process.env.PORT) || 8787;
const SWAN = "https://swan-api.jobright.ai";
const DESIRED_JOB_TYPES = new Set(["full-time", "part-time", "contract"]);
const DISALLOWED_SENIORITY_MARKERS = [
  "intern",
  "new grad",
  "entry",
  "mid",
  "junior",
  "jr",
  "associate",
];
const ALLOWED_SENIORITY_MARKERS = ["senior", "lead/staff", "lead", "staff", "director/executive"];
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

function normalizeField(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isAllowedEmploymentType(value) {
  const jobType = normalizeField(value);
  return DESIRED_JOB_TYPES.has(jobType);
}

function isAllowedSeniority(value) {
  const seniority = normalizeField(value);
  if (!seniority) return false;
  if (DISALLOWED_SENIORITY_MARKERS.some((x) => seniority.includes(x))) return false;
  return ALLOWED_SENIORITY_MARKERS.some((x) => seniority.includes(x));
}

function isUsRemoteJob(jr) {
  const workModel = normalizeField(jr?.workModel);
  const location = normalizeField(jr?.jobLocation);
  const isRemote = jr?.isRemote === true;

  if (!(isRemote || workModel === "remote")) return false;

  // Keep only US-wide remote jobs and city/state locations in the US.
  if (!location) return false;
  if (location.includes("united states") || location === "us" || location === "u.s.") {
    return true;
  }
  return /,\s*[a-z]{2}$/i.test(location);
}

function matchesHardFilters(row) {
  const jr = row?.jobResult;
  if (!jr) return false;
  if (!isUsRemoteJob(jr)) return false;
  if (!isAllowedEmploymentType(jr.employmentType)) return false;
  if (!isAllowedSeniority(jr.jobSeniority)) return false;
  return true;
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
 * Normalized company + posting job title key (same rules as dedupe).
 * @param {{ companyName?: string | null, jobTitle?: string | null }} job
 */
function companyTitleDedupeKey(job) {
  const companyRaw =
    typeof job?.companyName === "string" ? job.companyName.trim() : "";
  const titleRaw = typeof job?.jobTitle === "string" ? job.jobTitle.trim() : "";
  const company = companyRaw.toLowerCase().replace(/\s+/g, " ");
  const title = titleRaw.toLowerCase().replace(/\s+/g, " ");
  if (!company || !title) return "";
  return `${company}|||${title}`;
}

/**
 * Deduplicate by (company + job title). Keeps the oldest posting (by publishTime) for each pair.
 * @param {Array<any>} jobs
 */
function dedupeByCompanyAndTitleKeepOldest(jobs) {
  const bestByPair = new Map();
  const noPairKey = [];

  for (const job of jobs) {
    const key = companyTitleDedupeKey(job);

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
  const { keepDetail = false, maxPages: maxPagesOpt } = options;
  const maxPages =
    typeof maxPagesOpt === "number" && maxPagesOpt > 0 ? Math.min(60, maxPagesOpt) : 60;
  const windowMs = getWindowMs(timeWindow);
  if (!windowMs) throw new Error("Invalid timeWindow.");

  const cutoffTs = Date.now() - windowMs;
  const body = buildSearchBody(jobTitle);
  const out = [];
  const pageSize = 20;
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
      if (!matchesHardFilters(row)) continue;
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

/**
 * @param {Record<string, unknown>} body - multer fields
 * @returns {string[]} unique non-empty titles in order
 */
function parseJobTitlesFromBody(body) {
  const raw = body?.jobTitles;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const out = [];
        const seen = new Set();
        for (const item of parsed) {
          const t = String(item ?? "")
            .trim()
            .replace(/\s+/g, " ");
          if (!t || seen.has(t.toLowerCase())) continue;
          seen.add(t.toLowerCase());
          out.push(t);
        }
        return out;
      }
    } catch {
      /* fall through */
    }
  }
  const single = typeof body?.jobTitle === "string" ? body.jobTitle.trim().replace(/\s+/g, " ") : "";
  return single ? [single] : [];
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Combine embedding-based score with text overlap. When section text is short, cosine can be
 * anomalously low — do not let that drag the result below a strong text score (fixes inverted ranking).
 * When cosine is much higher than text, cap optimism (wrong-lane / generic prose).
 */
function blendSemanticFinal(semFinal, textFinal) {
  const t = Math.max(0, Math.min(100, textFinal));
  const s = Math.max(0, Math.min(100, semFinal));
  if (s < t - 15) {
    return Math.min(100, Math.round(0.88 * t + 0.12 * s + 1));
  }
  if (s > t + 14) {
    return Math.min(100, Math.round(0.52 * s + 0.48 * t + 3));
  }
  return Math.min(100, Math.round(0.45 * s + 0.55 * t + 2));
}

function blendSemanticSection(semV, textV) {
  const t = Math.max(0, Math.min(100, textV));
  const s = Math.max(0, Math.min(100, semV));
  if (s < t - 22) return t;
  if (s > t + 18) return Math.round(0.55 * s + 0.45 * t);
  return Math.round(0.46 * s + 0.54 * t);
}

/**
 * Run JobRight visitor search for several title strings (semantic expansion) and merge by jobId.
 * @param {string} jobTitleInput
 * @param {string} resumeText
 * @param {"24h"|"3d"|"7d"} timeWindow
 * @param {{ keepDetail?: boolean }} [options]
 */
async function collectJobsMergedWithTitleExpansion(jobTitleInput, resumeText, timeWindow, options) {
  const { queries, usedLlm } = await expandJobSearchQueries(jobTitleInput, resumeText);
  const merged = new Map();

  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await delay(160);
    const maxPages =
      queries.length === 1 ? 60 : i === 0 ? 28 : Math.max(10, Math.min(20, Math.floor(48 / queries.length)));
    const batch = await collectJobsForWindow(queries[i], timeWindow, {
      ...options,
      maxPages,
    });
    for (const job of batch) {
      if (!merged.has(job.jobId)) merged.set(job.jobId, job);
    }
  }

  return {
    jobs: Array.from(merged.values()),
    expandedQueries: queries,
    titleExpansionUsedLlm: usedLlm,
  };
}

/**
 * One normalized title: collect → score → optional semantic → dedupe → time window.
 * @param {string} resumeText
 * @param {string} jobTitleInput
 * @param {string} timeWindow
 * @param {string[]} signals
 */
async function runResumeSearchForTitle(resumeText, jobTitleInput, timeWindow, signals) {
  const searchTitle = normalizeJobSearchTitle(jobTitleInput);
  const searchRoleTrack = inferSearchRoleTrack(jobTitleInput);
  const { jobs: rawJobs, expandedQueries, titleExpansionUsedLlm } =
    await collectJobsMergedWithTitleExpansion(jobTitleInput, resumeText, "7d", {
      keepDetail: true,
    });

  const rawJobsFiltered = rawJobs.filter(
    (j) => !shouldExcludePostingForSearchTrack(searchRoleTrack, j.jobTitle)
  );

  const textScored = rawJobsFiltered
    .map((j) => {
      const row = j._row;
      const { _row, ...rest } = j;
      const { score, matchedKeywords, breakdown } = scoreJobAgainstResume(
        signals,
        row,
        resumeText,
        searchTitle
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
  let semanticAtsMode = false;
  if (hasSemanticKey() && rawJobsFiltered.length > 0) {
    try {
      semanticMap = await computeSemanticAtsMatchScores(rawJobsFiltered, resumeText, signals);
      semanticAtsMode = semanticMap.size > 0;
      semanticUsed = semanticAtsMode;
    } catch {
      semanticMap = new Map();
      semanticAtsMode = false;
    }
    if (!semanticAtsMode) {
      try {
        semanticMap = await computeSemanticSectionScores(rawJobsFiltered, resumeText);
        semanticUsed = semanticMap.size > 0;
      } catch {
        semanticMap = new Map();
        semanticUsed = false;
      }
    }
  }

  const jobs = textScored
    .map((j) => {
      const sem = semanticMap.get(j.jobId);
      if (!sem) return j;
      const textFinal = j.textScore ?? j.matchScore;
      const ts = j.textSectionScores || j.sectionScores;

      if (semanticAtsMode && "overall" in sem && "skillsMatch" in sem) {
        const blendedFinal = Math.min(
          100,
          Math.round(0.88 * sem.overall + 0.12 * textFinal)
        );
        return {
          ...j,
          matchScore: blendedFinal,
          scoringModel: "semantic_ats_v1",
          semanticAtsMode: true,
          atsDimensions: {
            skillsMatch: sem.skillsMatch,
            roleContentMatch: sem.roleContentMatch,
            seniorityMatch: sem.seniorityMatch,
            semanticCore: sem.overall,
          },
          sectionScores: {
            responsibilities: sem.roleContentMatch,
            qualifications: sem.skillsMatch,
            requiredPreferred: sem.seniorityMatch,
          },
        };
      }

      const blendedFinal = blendSemanticFinal(sem.final, textFinal);
      return {
        ...j,
        matchScore: blendedFinal,
        semanticRawFinal: sem.final,
        scoringModel: "semantic_sections_v1",
        semanticAtsMode: false,
        sectionScores: {
          responsibilities: blendSemanticSection(sem.responsibilities, ts.responsibilities),
          qualifications: blendSemanticSection(sem.qualifications, ts.qualifications),
          requiredPreferred: blendSemanticSection(sem.requiredPreferred, ts.requiredPreferred),
        },
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore);

  const dedupedJobs = dedupeByCompanyAndTitleKeepOldest(jobs);
  const jobsInSelectedWindow = filterJobsBySelectedWindow(dedupedJobs, timeWindow);

  return {
    jobTitleInput,
    searchTitle,
    searchRoleTrack,
    expandedQueries,
    titleExpansionUsedLlm,
    semanticUsed,
    semanticAtsMode,
    totalBeforeCompanyDedup: jobs.length,
    totalAfterCompanyDedup: dedupedJobs.length,
    jobs: jobsInSelectedWindow,
  };
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
    const tw = timeWindow.trim();
    const { jobs, expandedQueries, titleExpansionUsedLlm } =
      await collectJobsMergedWithTitleExpansion(jobTitle.trim(), "", tw, {
        keepDetail: false,
      });
    res.json({
      jobTitle: jobTitle.trim(),
      timeWindow: tw,
      titleSearchQueries: expandedQueries,
      titleExpansionUsedLlm,
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
    const jobTitles = parseJobTitlesFromBody(req.body);

    if (!req.file?.buffer) {
      res.status(400).json({ error: "Upload a PDF resume (field name: resume)." });
      return;
    }
    if (jobTitles.length === 0) {
      res.status(400).json({
        error:
          "Add at least one job function / title (e.g. Data Scientist, Machine Learning Engineer).",
      });
      return;
    }
    if (!getWindowMs(timeWindow)) {
      res.status(400).json({
        error: "timeWindow is required: 24h, 3d, or 7d.",
      });
      return;
    }

    const tw = timeWindow.trim();

    try {
      const resumeText = await parseResumePdf(req.file.buffer);
      if (!resumeText || resumeText.trim().length < 40) {
        res.status(400).json({
          error: "Could not read enough text from the PDF. Try another file or a text-based PDF.",
        });
        return;
      }

      const resumeHeadline = inferJobTitleFromResume(resumeText);
      const signals = extractResumeSignals(resumeText);
      const resumePreview = resumeText.slice(0, 320).replace(/\s+/g, " ").trim();

      const resultsByTitle = [];
      let semanticUsedAny = false;
      let semanticAtsAny = false;

      for (let i = 0; i < jobTitles.length; i++) {
        if (i > 0) await delay(200);
        const block = await runResumeSearchForTitle(resumeText, jobTitles[i], tw, signals);
        semanticUsedAny = semanticUsedAny || block.semanticUsed;
        semanticAtsAny = semanticAtsAny || block.semanticAtsMode;
        const jobsTagged = block.jobs.map((j) => ({
          ...j,
          queryJobTitle: block.jobTitleInput,
          querySearchTitle: block.searchTitle,
        }));
        resultsByTitle.push({
          jobTitleInput: block.jobTitleInput,
          searchTitle: block.searchTitle,
          searchRoleTrack: block.searchRoleTrack,
          semanticAtsMode: block.semanticAtsMode,
          titleSearchQueries: block.expandedQueries,
          titleExpansionUsedLlm: block.titleExpansionUsedLlm,
          count: jobsTagged.length,
          companyTitleDedupWindow: "7d",
          totalBeforeCompanyDedup: block.totalBeforeCompanyDedup,
          totalAfterCompanyDedup: block.totalAfterCompanyDedup,
          jobs: jobsTagged,
        });
      }

      if (jobTitles.length > 1) {
        const jobIdFirstBlockIndex = new Map();
        resultsByTitle.forEach((block, idx) => {
          for (const j of block.jobs) {
            if (!jobIdFirstBlockIndex.has(j.jobId)) jobIdFirstBlockIndex.set(j.jobId, idx);
          }
        });

        const flatForGlobal = resultsByTitle.flatMap((b) => b.jobs);
        const globalCompanyTitleDeduped = dedupeByCompanyAndTitleKeepOldest(flatForGlobal);
        const survivingJobIds = new Set(globalCompanyTitleDeduped.map((j) => j.jobId));

        for (let idx = 0; idx < resultsByTitle.length; idx++) {
          const block = resultsByTitle[idx];
          const filtered = block.jobs.filter(
            (j) =>
              survivingJobIds.has(j.jobId) && jobIdFirstBlockIndex.get(j.jobId) === idx
          );
          block.jobs = filtered;
          block.count = filtered.length;
        }
      }

      const seenIds = new Set();
      const jobsFlat = [];
      for (const block of resultsByTitle) {
        for (const j of block.jobs) {
          if (seenIds.has(j.jobId)) continue;
          seenIds.add(j.jobId);
          jobsFlat.push(j);
        }
      }

      if (jobTitles.length === 1) {
        const only = resultsByTitle[0];
        res.json({
          jobTitleInput: only.jobTitleInput,
          searchTitle: only.searchTitle,
          searchRoleTrack: only.searchRoleTrack,
          titleSearchQueries: only.expandedQueries,
          titleExpansionUsedLlm: only.titleExpansionUsedLlm,
          resumeHeadline,
          timeWindow: tw,
          resumeSignals: signals,
          resumePreview,
          semanticUsed: only.semanticUsed,
          semanticAtsMode: only.semanticAtsMode,
          count: only.jobs.length,
          companyTitleDedupWindow: "7d",
          totalBeforeCompanyDedup: only.totalBeforeCompanyDedup,
          totalAfterCompanyDedup: only.totalAfterCompanyDedup,
          jobs: only.jobs.map(({ queryJobTitle, querySearchTitle, ...rest }) => rest),
        });
        return;
      }

      res.json({
        multiTitle: true,
        jobTitlesInput: jobTitles,
        jobTitleInput: jobTitles.join(", "),
        searchTitle: resultsByTitle.map((r) => r.searchTitle).join(" · "),
        titleExpansionUsedLlm: resultsByTitle.some((r) => r.titleExpansionUsedLlm),
        resumeHeadline,
        timeWindow: tw,
        resumeSignals: signals,
        resumePreview,
        semanticUsed: semanticUsedAny,
        semanticAtsMode: semanticAtsAny,
        count: jobsFlat.length,
        companyTitleDedupWindow: "7d",
        finalCrossTitleDedup:
          "After all titles: one more pass on the combined list by company + job title (keep oldest publish time). Each surviving job is shown only under the first search title that returned it.",
        resultsByTitle,
        jobs: jobsFlat,
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
