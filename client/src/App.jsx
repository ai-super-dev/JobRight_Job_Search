import { useMemo, useState } from "react";

function todayLocalISODate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function App() {
  const [jobTitle, setJobTitle] = useState("");
  const [postedDate, setPostedDate] = useState(todayLocalISODate);
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
      fd.append("postedDate", postedDate);
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
          Enter the role you want, choose the calendar day listings must have been posted, upload your
          resume, then search. Results are jobs for that title on that date from JobRight, ordered by
          how closely each posting&apos;s description aligns with your resume (skills, tools, and
          keywords). Links: <code>https://jobright.ai/jobs/info/&lt;id&gt;</code>.
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
            <span className="step-label">Posted date</span>
            <input
              className="input"
              type="date"
              value={postedDate}
              onChange={(e) => setPostedDate(e.target.value)}
              aria-label="Posted date"
            />
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
            Ranked jobs — {resumeData.searchTitle} — posted {resumeData.postedDate}
          </h2>
          <p className="resume-meta subtle">
            Scoring weights the job summary, requirements, and responsibilities against your resume
            (plus the job title). Higher % means stronger overlap.
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
                    <span className="score">{j.matchScore}%</span>
                    <a className="link" href={j.url} target="_blank" rel="noreferrer">
                      {j.jobTitle}
                    </a>
                  </div>
                  {j.companyName ? (
                    <span className="meta">
                      {j.companyName} · {j.publishTime}
                    </span>
                  ) : (
                    <span className="meta">{j.publishTime}</span>
                  )}
                  {j.matchedKeywords?.length > 0 ? (
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
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No jobs on that date for this search title on JobRight.</p>
          )}
        </section>
      ) : !loading && !error ? (
        <p className="hint">Complete all three steps, then click Search.</p>
      ) : null}
    </div>
  );
}
