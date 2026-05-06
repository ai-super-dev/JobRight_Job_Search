import { useMemo, useState } from "react";

const TIME_WINDOW_OPTIONS = [
  { value: "24h", label: "Past 24 hours" },
  { value: "3d", label: "Past 3 days" },
  { value: "7d", label: "Past 1 week" },
];

function normalizeTitleInput(s) {
  return s.trim().replace(/\s+/g, " ");
}

function JobRow({ job, semanticUsed }) {
  const j = job;
  return (
    <li className="row">
      <div className="rank-line">
        <span className="score">Final {j.matchScore}%</span>
        <a className="link" href={j.url} target="_blank" rel="noreferrer">
          {j.jobTitle}
        </a>
      </div>
      {j.sectionScores ? (
        <div className="section-scores">
          <span className="tag small">Responsibilities {j.sectionScores.responsibilities}%</span>
          <span className="tag small">Qualifications {j.sectionScores.qualifications}%</span>
          <span className="tag small">Required/Preferred {j.sectionScores.requiredPreferred}%</span>
        </div>
      ) : null}
      {j.companyName ? (
        <span className="meta">
          {j.companyName} · {j.publishTime}
        </span>
      ) : (
        <span className="meta">{j.publishTime}</span>
      )}
      {!semanticUsed ? (
        j.matchedKeywords?.length > 0 ? (
          <div className="matched">
            Overlap:{" "}
            {j.matchedKeywords.map((k) => (
              <span key={k} className="tag small">
                {k}
              </span>
            ))}
          </div>
        ) : (
          <div className="matched muted">Little text overlap with this posting.</div>
        )
      ) : null}
    </li>
  );
}

export default function App() {
  const [jobTitles, setJobTitles] = useState([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [timeWindow, setTimeWindow] = useState("24h");
  const [resumeFile, setResumeFile] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resumeData, setResumeData] = useState(null);

  const apiBase = useMemo(() => {
    return import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "";
  }, []);

  function addTitleFromDraft() {
    const t = normalizeTitleInput(titleDraft);
    if (!t) return;
    setJobTitles((prev) => {
      if (prev.some((x) => x.toLowerCase() === t.toLowerCase())) return prev;
      return [...prev, t];
    });
    setTitleDraft("");
  }

  function removeTitle(title) {
    setJobTitles((prev) => prev.filter((x) => x !== title));
  }

  function onTitleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      addTitleFromDraft();
    }
  }

  async function onSearch(e) {
    e.preventDefault();
    if (jobTitles.length === 0) {
      setError("Add at least one job function (press Enter after typing, or use Add).");
      setResumeData(null);
      return;
    }
    if (!resumeFile) {
      setError("Upload your resume as a PDF.");
      setResumeData(null);
      return;
    }
    setError(null);
    setResumeData(null);
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("resume", resumeFile);
      fd.append("timeWindow", timeWindow);
      fd.append("jobTitles", JSON.stringify(jobTitles));
      const res = await fetch(`${apiBase}/api/jobs-from-resume`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || res.statusText || "Request failed");
      }
      setResumeData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const multi = Boolean(resumeData?.multiTitle && resumeData?.resultsByTitle?.length > 1);

  return (
    <div className="layout">
      <header className="header">
        <h1>JobRight — ranked same-day matches</h1>
        <p className="lede">
          Add one or more job functions, choose a recent window (24h / 3d / 1w), upload your resume,
          then search. With <code>OPENAI_API_KEY</code> set, each function is expanded into related
          JobRight title searches (e.g. ML engineer → machine learning roles), merged, then ranked
          against your resume. Links: <code>https://jobright.ai/jobs/info/&lt;id&gt;</code>.
        </p>
        <p className="subtle">
          Fixed filters: Country US, US-remote only, job type in Full-time/Part-time/Contract, and
          seniority at Senior/Lead/Staff+ (intern/entry/mid excluded).
        </p>
      </header>

      <form className="card form search-flow" onSubmit={onSearch}>
        <ol className="steps">
          <li className="step">
            <div className="job-function-panel">
              <label className="job-function-label" htmlFor="job-function-input">
                <span className="job-function-required">*</span> Job function
              </label>
              <div className="job-function-chips" aria-live="polite">
                {jobTitles.map((t) => (
                  <span key={t} className="job-function-chip">
                    {t}
                    <button
                      type="button"
                      className="job-function-chip-remove"
                      onClick={() => removeTitle(t)}
                      aria-label={`Remove ${t}`}
                    >
                    ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="job-function-input-row">
                <input
                  id="job-function-input"
                  className="input job-function-field"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={onTitleKeyDown}
                  placeholder="Please select/enter your expected job function"
                  autoComplete="off"
                  aria-label="Add job function"
                />
                <button type="button" className="btn job-function-add" onClick={addTitleFromDraft}>
                  Add
                </button>
              </div>
              <p className="job-function-hint subtle">
                Type a title and press <kbd>Enter</kbd> or <strong>Add</strong>. Searches run in
                list order (e.g. Data Engineer, then Data Scientist, then Data Analyst).
              </p>
            </div>
          </li>
          <li className="step">
            <span className="step-label">Posted within</span>
            <select
              className="input"
              value={timeWindow}
              onChange={(e) => setTimeWindow(e.target.value)}
              aria-label="Time window"
            >
              {TIME_WINDOW_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </li>
          <li className="step">
            <span className="step-label">Resume (PDF)</span>
            <input
              className="input file-input"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
              aria-label="Resume PDF file"
            />
          </li>
        </ol>
        <button className="btn search-primary job-function-confirm" type="submit" disabled={loading}>
          {loading ? "Searching…" : "Confirm"}
        </button>
      </form>

      {error ? <div className="card error">{error}</div> : null}

      {resumeData ? (
        <section className="card results">
          <h2 className="results-title">
            Ranked jobs ({resumeData.count})
            {multi ? (
              <> — {resumeData.jobTitlesInput?.length ?? 0} titles — </>
            ) : (
              <> — {resumeData.searchTitle} — </>
            )}
            {TIME_WINDOW_OPTIONS.find((x) => x.value === resumeData.timeWindow)?.label ??
              resumeData.timeWindow}
          </h2>
          <p className="resume-meta subtle">
            Scoring weights the job summary, requirements, and responsibilities against your resume.
            JobRight discovery uses multiple title strings per chip when AI expansion is enabled.
            Higher % means stronger overlap. Each row shows 4 scores: final, responsibilities,
            qualifications, and required/preferred.
            {resumeData.semanticUsed ? (
              <> Semantic mode: <strong>AI embeddings</strong>.</>
            ) : (
              <> Semantic mode: <strong>off</strong> (fallback text overlap).</>
            )}
            {resumeData.resumeHeadline ? (
              <>
                {" "}
                Detected on resume: <em>{resumeData.resumeHeadline}</em>.
              </>
            ) : null}
          </p>
          {resumeData.resumeSignals?.length > 0 ? (
            <div className="signals">
              <span className="signals-label">Structured signals from your resume:</span>
              {resumeData.resumeSignals.map((s) => (
                <span key={s} className="tag">
                  {s}
                </span>
              ))}
            </div>
          ) : null}
          {!multi &&
          resumeData.searchRoleTrack &&
          resumeData.searchRoleTrack !== "generic" ? (
            <p className="resume-meta subtle title-queries-note">
              Role track: <strong>{resumeData.searchRoleTrack.replace(/_/g, " ")}</strong>
              {resumeData.searchRoleTrack === "data_science" ? (
                <>
                  {" "}
                  — job titles that are clearly Data Engineering (e.g. Data Engineer, data
                  engineering without &quot;scientist&quot;) are excluded from this search.
                </>
              ) : (
                <> — postings outside this lane are filtered by job title.</>
              )}
            </p>
          ) : null}
          {!multi &&
          Array.isArray(resumeData.titleSearchQueries) &&
          resumeData.titleSearchQueries.length > 0 ? (
            <p className="resume-meta subtle title-queries-note">
              <span className="signals-label">Title searches merged:</span>{" "}
              {resumeData.titleSearchQueries.map((q) => (
                <span key={q} className="tag small">
                  {q}
                </span>
              ))}
              {resumeData.titleExpansionUsedLlm === false ? (
                <span className="muted-inline">
                  {" "}
                  (AI title expansion off — set <code>OPENAI_API_KEY</code> on the server for related
                  roles.)
                </span>
              ) : null}
            </p>
          ) : null}
          {multi && resumeData.finalCrossTitleDedup ? (
            <p className="resume-meta subtle title-queries-note">{resumeData.finalCrossTitleDedup}</p>
          ) : null}
          {multi && resumeData.resultsByTitle ? (
            <div className="multi-title-results">
              {resumeData.resultsByTitle.map((block) => (
                <section key={block.searchTitle + block.jobTitleInput} className="title-block">
                  <h3 className="title-block-heading">
                    <span className="title-block-query">{block.jobTitleInput}</span>
                    <span className="title-block-meta subtle">
                      → normalized &quot;{block.searchTitle}&quot; · {block.count} jobs
                    </span>
                  </h3>
                  {block.searchRoleTrack && block.searchRoleTrack !== "generic" ? (
                    <p className="title-block-queries subtle">
                      Track: <strong>{block.searchRoleTrack.replace(/_/g, " ")}</strong>
                      {block.searchRoleTrack === "data_science"
                        ? " — data engineer / pure data-engineering titles excluded."
                        : " — off-lane titles excluded."}
                    </p>
                  ) : null}
                  {Array.isArray(block.titleSearchQueries) && block.titleSearchQueries.length > 0 ? (
                    <p className="title-block-queries subtle">
                      <span className="signals-label">Searches:</span>{" "}
                      {block.titleSearchQueries.map((q) => (
                        <span key={`${block.jobTitleInput}-${q}`} className="tag small">
                          {q}
                        </span>
                      ))}
                    </p>
                  ) : null}
                  {block.jobs?.length > 0 ? (
                    <ul className="list">
                      {block.jobs.map((j) => (
                        <JobRow
                          key={`${block.searchTitle}-${j.jobId}`}
                          job={j}
                          semanticUsed={resumeData.semanticUsed}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="hint">No jobs in that time window for this title on JobRight.</p>
                  )}
                </section>
              ))}
            </div>
          ) : resumeData.jobs?.length > 0 ? (
            <ul className="list">
              {resumeData.jobs.map((j) => (
                <JobRow key={j.jobId} job={j} semanticUsed={resumeData.semanticUsed} />
              ))}
            </ul>
          ) : (
            <p className="hint">No jobs in that time window for this search title on JobRight.</p>
          )}
        </section>
      ) : !loading && !error ? (
        <p className="hint">Add job functions, time window, and resume, then click Confirm.</p>
      ) : null}
    </div>
  );
}
