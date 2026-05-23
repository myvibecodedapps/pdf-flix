import { useState } from "react";
import { Scissors, Download, X, Info } from "lucide-react";
import FileDrop from "./FileDrop";
import PageThumb from "./PageThumb";
import PageViewer from "./PageViewer";
import { humanBytes, splitJob, uploadPdf, type Job, type SplitResult } from "../lib/api";

type Mode = "ranges" | "every" | "select" | "by-pages" | "by-size";

export default function SplitTool() {
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("ranges");
  const [rangesText, setRangesText] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pagesPerChunk, setPagesPerChunk] = useState("10");
  const [mbPerChunk, setMbPerChunk] = useState("5");
  const [result, setResult] = useState<SplitResult | null>(null);

  const [viewing, setViewing] = useState<number | null>(null);

  async function onUpload(files: File[]) {
    if (!files[0]) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const j = await uploadPdf(files[0], setProgress);
      setJob(j);
      setRangesText(`1-${j.pages}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false); setProgress(0);
    }
  }

  function buildRanges(): string {
    if (!job) return "";
    if (mode === "ranges") return rangesText.trim();
    if (mode === "every") {
      return Array.from({ length: job.pages }, (_, i) => `${i + 1}`).join(",");
    }
    // select
    const arr = Array.from(selected).sort((a, b) => a - b);
    if (!arr.length) return "";
    const out: string[] = [];
    let s = arr[0], p = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === p + 1) p = arr[i];
      else { out.push(s === p ? `${s}` : `${s}-${p}`); s = p = arr[i]; }
    }
    out.push(s === p ? `${s}` : `${s}-${p}`);
    return out.join(",");
  }

  async function run() {
    if (!job) return;
    setError(null); setResult(null);
    try {
      if (mode === "by-pages") {
        const n = parseInt(pagesPerChunk, 10);
        if (!n || n < 1) { setError("Pages per file must be at least 1."); return; }
        setBusy(true);
        setResult(await splitJob(job.job_id, { mode: "every-n", pages_per_chunk: n }));
      } else if (mode === "by-size") {
        const mb = parseFloat(mbPerChunk);
        if (!mb || mb <= 0) { setError("Size per file must be > 0 MB."); return; }
        setBusy(true);
        setResult(await splitJob(job.job_id, { mode: "by-size", size_per_chunk_mb: mb }));
      } else {
        const r = buildRanges();
        if (!r) { setError("Pick at least one page or range."); return; }
        setBusy(true);
        const splitMode = mode === "select" ? "combined" : "zip";
        setResult(await splitJob(job.job_id, { mode: splitMode, ranges: r }));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function togglePage(p: number) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  }

  const autoMode = mode === "by-pages" || mode === "by-size";

  return (
    <div>
      <Header title="Split" />

      {!job && <FileDrop onFiles={onUpload} busy={busy} progress={progress} />}

      {job && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div className="min-w-0">
            <FileBadge job={job} onClear={() => { setJob(null); setSelected(new Set()); setResult(null); }} />

            <Tabs value={mode} onChange={(v) => { setMode(v as Mode); setResult(null); }} options={[
              { id: "ranges",   label: "Ranges" },
              { id: "every",    label: "Every page" },
              { id: "select",   label: "Pick pages" },
              { id: "by-pages", label: "By pages" },
              { id: "by-size",  label: "By size" },
            ]} />

            {mode === "ranges" && (
              <div className="mt-4">
                <label className="text-sm text-muted">Pages (e.g. <code className="text-white">1-3, 5, 8-10</code>)</label>
                <input
                  value={rangesText}
                  onChange={(e) => setRangesText(e.target.value)}
                  className="mt-2 w-full bg-panel border border-white/10 rounded-md px-4 py-2.5 font-mono focus:outline-none focus:border-accent"
                />
              </div>
            )}

            {mode === "select" && (
              <p className="mt-4 text-sm text-muted">
                Click thumbnails to include · Selected: <span className="text-white">{selected.size}</span> / {job.pages}
              </p>
            )}

            {mode === "by-pages" && (
              <div className="mt-4 max-w-sm">
                <label className="text-sm text-muted">Pages per file</label>
                <div className="flex items-center gap-2 mt-2">
                  <input
                    type="number" inputMode="numeric" min="1"
                    value={pagesPerChunk}
                    onChange={(e) => setPagesPerChunk(e.target.value)}
                    className="flex-1 bg-panel border border-white/10 rounded-md px-4 py-2.5 font-mono focus:outline-none focus:border-accent"
                  />
                  <span className="text-sm text-muted">pages</span>
                </div>
                <p className="text-xs text-muted mt-2">
                  A {job.pages}-page PDF split at {pagesPerChunk || "?"} pages per file
                  produces{" "}
                  <span className="text-white">
                    {pagesPerChunk && parseInt(pagesPerChunk, 10) > 0
                      ? Math.ceil(job.pages / parseInt(pagesPerChunk, 10))
                      : "?"}
                  </span>{" "}
                  files (last one may be smaller).
                </p>
              </div>
            )}

            {mode === "by-size" && (
              <div className="mt-4 max-w-sm">
                <label className="text-sm text-muted">Maximum size per file</label>
                <div className="flex items-center gap-2 mt-2">
                  <input
                    type="number" inputMode="decimal" min="0.1" step="0.1"
                    value={mbPerChunk}
                    onChange={(e) => setMbPerChunk(e.target.value)}
                    className="flex-1 bg-panel border border-white/10 rounded-md px-4 py-2.5 font-mono focus:outline-none focus:border-accent"
                  />
                  <span className="text-sm text-muted">MB</span>
                </div>
                <p className="text-xs text-muted mt-2">
                  Pages are grouped one chunk at a time, growing each chunk until
                  the saved PDF would exceed the target. Each output file ends up
                  ≤ {mbPerChunk || "?"} MB. May take a moment on big PDFs.
                </p>
              </div>
            )}

            {!autoMode && (
              <PageGrid
                jobId={job.job_id}
                total={job.pages}
                selected={mode === "select" ? selected : null}
                onToggle={mode === "select" ? togglePage : undefined}
                onView={(p) => setViewing(p)}
              />
            )}

            {result?.notice && (
              <div className="mt-4 flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 min-w-0">
                <Info className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 text-sm text-amber-100/90 break-words">
                  {result.notice}
                </div>
              </div>
            )}

            {result?.chunks && result.chunks.length > 0 && (
              <div className="mt-4 bg-panel/60 border border-white/5 rounded-lg p-4 min-w-0">
                <div className="text-xs uppercase tracking-wider text-muted mb-3">
                  {result.chunks.length} output{result.chunks.length === 1 ? "" : "s"}
                </div>
                <ul className="space-y-1.5">
                  {result.chunks.map((c) => (
                    <li key={c.index} className="flex items-center gap-3 text-sm bg-panel2/60 rounded px-3 py-2">
                      <span className="font-mono text-xs w-6 text-muted">{c.index}</span>
                      <span className="flex-1 min-w-0 truncate">
                        pages <span className="font-mono text-white">{c.pages}</span>
                        <span className="text-muted"> · {c.page_count} pg</span>
                      </span>
                      <span className="font-mono text-xs text-emerald-300">
                        {humanBytes(c.size)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <SidePanel error={error}>
            <RunButton onClick={run} busy={busy} icon={<Scissors className="w-4 h-4" />} label="Split" />
            {result && <DownloadCard result={result} />}
          </SidePanel>
        </div>
      )}

      {job && viewing !== null && (
        <PageViewer
          jobId={job.job_id}
          totalPages={job.pages}
          initialPage={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

export function Header({ title }: { title: string }) {
  return (
    <h1 className="text-3xl font-bold tracking-tight mb-6">{title}</h1>
  );
}

export function FileBadge({ job, onClear }: { job: Job; onClear: () => void }) {
  return (
    <div className="flex items-center gap-3 bg-panel rounded-lg px-4 py-3 mb-5 border border-white/5">
      <div className="w-9 h-9 rounded-md bg-accent/15 flex items-center justify-center text-accent text-xs font-bold">PDF</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{job.filename}</div>
        <div className="text-xs text-muted">{job.pages} pages · {humanBytes(job.size_bytes)}</div>
      </div>
      <button onClick={onClear} className="text-muted hover:text-white p-1" aria-label="Remove">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function Tabs<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div className="flex flex-wrap bg-panel rounded-md p-1 border border-white/5 w-full sm:w-auto sm:inline-flex">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`flex-1 sm:flex-none px-3.5 py-1.5 text-sm rounded-[5px] transition-colors ${
            value === o.id ? "bg-accent text-white" : "text-muted hover:text-white"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PageGrid({
  jobId, total, selected, onToggle, onView,
}: {
  jobId: string;
  total: number;
  selected: Set<number> | null;
  onToggle?: (p: number) => void;
  onView?: (p: number) => void;
}) {
  return (
    <div className="mt-5 grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 gap-2.5">
      {Array.from({ length: total }, (_, i) => i + 1).map((p) => (
        <button
          key={p}
          type="button"
          onClick={onToggle ? () => onToggle(p) : onView ? () => onView(p) : undefined}
          className="block group focus:outline-none"
          aria-label={onToggle ? `Toggle page ${p}` : `View page ${p}`}
        >
          <PageThumb
            jobId={jobId}
            page={p}
            selected={!!selected?.has(p)}
            onView={onView ? () => onView(p) : undefined}
          />
        </button>
      ))}
    </div>
  );
}

export function SidePanel({ children, error }: { children: React.ReactNode; error?: string | null }) {
  return (
    <aside className="lg:sticky lg:top-6 self-start space-y-3 bg-panel/60 border border-white/5 rounded-lg p-4">
      {error && (
        <div className="text-sm text-red-300 bg-red-950/40 border border-red-900/40 rounded p-3">
          {error}
        </div>
      )}
      {children}
    </aside>
  );
}

export function RunButton({
  onClick, busy, icon, label,
}: {
  onClick: () => void;
  busy?: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-white font-semibold px-5 py-2.5 rounded-md"
    >
      {busy ? <Spinner /> : icon}
      {busy ? "Working…" : label}
    </button>
  );
}

export function DownloadCard({ result }: { result: { download: string; filename: string } }) {
  return (
    <a
      href={result.download}
      download={result.filename}
      className="flex items-center gap-3 bg-emerald-600/15 border border-emerald-500/30 hover:bg-emerald-600/25 rounded-lg p-3 transition-colors"
    >
      <Download className="w-5 h-5 text-emerald-300" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-emerald-200">Ready</div>
        <div className="text-xs text-emerald-200/70 truncate">{result.filename}</div>
      </div>
    </a>
  );
}

export function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
