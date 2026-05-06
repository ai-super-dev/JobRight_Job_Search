import { useMemo, useState } from "react";

const TIME_WINDOW_OPTIONS = [
  { value: "24h", label: "Past 24 hours" },
  { value: "3d", label: "Past 3 days" },
  { value: "7d", label: "Past 1 week" },
];

export default function App() {
  const [jobTitle, setJobTitle] = useState("");
  const [timeWindow, setTimeWindow] = useState("24h");
  const [resumeFile, setResumeFile] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resumeData, setResumeData] = useState(null);

  const apiBase = useMemo(() => {
    return import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "";
  }, []);

  async function onSearch(e) {
    e.preventDefault();
    if (!jobTitle.trim()) {
      setError("Enter a job title (e.g. data scientist).");
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
      fd.append("jobTitle", jobTitle.trim());
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

  return (
    <div className="layout">
      <header className="header">
        <h1>JobRight — ranked same-day matches</h1>
        <p className="lede">
          Enter the role you want, choose a recent window (24h / 3d / 1w), upload your resume,
          then search. Results are jobs for that title within that window from JobRight, ordered by
          how closely each posting&apos;s description aligns with your resume. Links:{" "}
          <code>https://jobright.ai/jobs/info/&lt;id&gt;</code>.
        </p>
      </header>

      <form className="card form search-flow" onSubmit={onSearch}>
        <ol className="steps">
          <li className="step">
            <span className="step-label">Job title</span>
            <input
              className="input"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder='e.g. "data scientist"'
              autoComplete="off"
              aria-label="Job title"
            />
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
        <button className="btn search-primary" type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error ? <div className="card error">{error}</div> : null}

      {resumeData ? (
        <section className="card results">
          <h2 className="results-title">
            Ranked jobs ({resumeData.count}) — {resumeData.searchTitle} —{" "}
            {TIME_WINDOW_OPTIONS.find((x) => x.value === resumeData.timeWindow)?.label ??
              resumeData.timeWindow}
          </h2>
          <p className="resume-meta subtle">
            Scoring weights the job summary, requirements, and responsibilities against your resume
            (plus the job title). Higher % means stronger overlap.
            {" "}Each row shows 4 scores: final, responsibilities, qualifications, and
            required/preferred.
            {resumeData.semanticUsed ? (
              <> Semantic mode: <strong>AI embeddings</strong>.</>
            ) : (
              <> Semantic mode: <strong>off</strong> (fallback text overlap).</>
            )}
            {resumeData.resumeHeadline &&
            resumeData.resumeHeadline.toLowerCase() !== resumeData.searchTitle?.toLowerCase() ? (
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
          {resumeData.jobs?.length > 0 ? (
            <ul className="list">
              {resumeData.jobs.map((j) => (
                <li key={j.jobId} className="row">
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
                  {!resumeData.semanticUsed ? (
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
              ))}
            </ul>
          ) : (
            <p className="hint">No jobs in that time window for this search title on JobRight.</p>
          )}
        </section>
      ) : !loading && !error ? (
        <p className="hint">Complete all three steps, then click Search.</p>
      ) : null}
    </div>
  );
}
