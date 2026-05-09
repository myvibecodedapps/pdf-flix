import { useState } from "react";
import { Scissors, Download, X } from "lucide-react";
import FileDrop from "./FileDrop";
import PageThumb from "./PageThumb";
import PageViewer from "./PageViewer";
import { humanBytes, splitJob, uploadPdf, type Job } from "../lib/api";

type Mode = "ranges" | "every" | "select";

export default function SplitTool() {
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("ranges");
  const [rangesText, setRangesText] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<{ download: string; filename: string } | null>(null);

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
    const r = buildRanges();
    if (!r) { setError("Pick at least one page or range."); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const splitMode = mode === "select" ? "combined" : "zip";
      setResult(await splitJob(job.job_id, r, splitMode));
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

  return (
    <div>
      <Header title="Split" />

      {!job && <FileDrop onFiles={onUpload} busy={busy} progress={progress} />}

      {job && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div>
            <FileBadge job={job} onClear={() => { setJob(null); setSelected(new Set()); setResult(null); }} />

            <Tabs value={mode} onChange={(v) => setMode(v as Mode)} options={[
              { id: "ranges", label: "Ranges" },
              { id: "every", label: "Every page" },
              { id: "select", label: "Pick pages" },
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

            <PageGrid
              jobId={job.job_id}
              total={job.pages}
              selected={mode === "select" ? selected : null}
              onToggle={mode === "select" ? togglePage : undefined}
              onView={(p) => setViewing(p)}
            />
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
    <div className="inline-flex bg-panel rounded-md p-1 border border-white/5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`px-3.5 py-1.5 text-sm rounded-[5px] transition-colors ${
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
