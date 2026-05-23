import { useState } from "react";
import { Shrink, ArrowRight, Info, Target, CheckCircle2, XCircle } from "lucide-react";
import FileDrop from "./FileDrop";
import { compressJob, humanBytes, uploadPdf, type CompressResult, type Job } from "../lib/api";
import { DownloadCard, FileBadge, Header, RunButton, SidePanel } from "./SplitTool";

type Level = "strong" | "medium" | "light" | "minimal" | "extreme";

const LEVELS: { id: Level; label: string; sub: string }[] = [
  { id: "strong",  label: "Strong",  sub: "~72 dpi · smallest single-shot" },
  { id: "medium",  label: "Medium",  sub: "~150 dpi · balanced" },
  { id: "light",   label: "Light",   sub: "~300 dpi · print quality" },
  { id: "minimal", label: "Minimal", sub: "~300 dpi · near-original" },
  { id: "extreme", label: "Extreme", sub: "72 dpi, forced low-quality JPEG" },
];

export default function CompressTool() {
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("medium");
  const [targetMb, setTargetMb] = useState<string>("");
  const [result, setResult] = useState<CompressResult | null>(null);

  async function onUpload(files: File[]) {
    if (!files[0]) return;
    setBusy(true); setError(null); setResult(null);
    try {
      setJob(await uploadPdf(files[0], setProgress));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false); setProgress(0);
    }
  }

  async function run() {
    if (!job) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const t = parseFloat(targetMb);
      setResult(await compressJob(job.job_id, level, isFinite(t) && t > 0 ? t : undefined));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const targetMode = parseFloat(targetMb) > 0;

  return (
    <div>
      <Header title="Compress" />

      {!job && <FileDrop onFiles={onUpload} busy={busy} progress={progress} />}

      {job && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div className="space-y-4 min-w-0">
            <FileBadge job={job} onClear={() => { setJob(null); setResult(null); }} />

            <div className="bg-panel/60 border border-white/5 rounded-lg p-4 space-y-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted mb-2">
                  Compression level
                </div>
                <select
                  value={level}
                  onChange={(e) => setLevel(e.target.value as Level)}
                  disabled={targetMode}
                  className="w-full bg-panel2 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent disabled:opacity-50"
                >
                  {LEVELS.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label} — {l.sub}
                    </option>
                  ))}
                </select>
              </div>

              <div className="border-t border-white/5 pt-4">
                <div className="text-xs uppercase tracking-wider text-muted mb-2 flex items-center gap-2">
                  <Target className="w-3 h-3" /> Target size (optional)
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0.1"
                    step="0.1"
                    placeholder="e.g. 5"
                    value={targetMb}
                    onChange={(e) => setTargetMb(e.target.value)}
                    className="flex-1 bg-panel2 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent"
                  />
                  <span className="text-sm text-muted">MB</span>
                </div>
                <p className="text-xs text-muted mt-2">
                  When set, PDFflix iterates from gentle to aggressive settings
                  and stops at the first attempt that fits. Overrides the
                  dropdown above. May take a minute on big PDFs.
                </p>
              </div>
            </div>

            {result?.notice && (
              <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 min-w-0">
                <Info className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 text-sm text-amber-100/90 break-words">
                  {result.notice}
                </div>
              </div>
            )}

            {result && (
              <div className="bg-panel/60 border border-white/5 rounded-lg p-4 min-w-0">
                <div className="text-xs uppercase tracking-wider text-muted mb-3 break-words">
                  Result · {result.level_label}
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  <SizeBlock label="Original" bytes={result.original_size} />
                  <ArrowRight className="w-5 h-5 text-muted shrink-0" />
                  <SizeBlock label="Compressed" bytes={result.new_size} accent />
                  <div className="ml-auto text-right">
                    <div className="text-2xl font-bold text-emerald-300">
                      {result.ratio_percent > 0 ? `-${result.ratio_percent}%` : "0%"}
                    </div>
                    <div className="text-xs text-muted">
                      {humanBytes(result.saved_bytes)} saved
                    </div>
                  </div>
                </div>
                <div className="mt-4 h-2 bg-panel2 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, result.ratio_percent))}%` }}
                  />
                </div>

                {result.attempts && result.attempts.length > 0 && (
                  <details className="mt-4">
                    <summary className="text-xs text-muted cursor-pointer hover:text-white">
                      Show {result.attempts.length} attempt{result.attempts.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {result.attempts.map((a, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-2 text-xs bg-panel2/60 rounded px-2 py-1.5"
                        >
                          {a.error ? (
                            <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          ) : a.fits ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          ) : (
                            <span className="w-3.5 h-3.5 rounded-full border border-white/20 shrink-0" />
                          )}
                          <span className="flex-1 min-w-0 truncate">{a.label}</span>
                          <span className="text-muted">
                            {a.size === null ? "error" : humanBytes(a.size)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>

          <SidePanel error={error}>
            <RunButton
              onClick={run}
              busy={busy}
              icon={<Shrink className="w-4 h-4" />}
              label={targetMode ? `Compress to ≤ ${targetMb} MB` : "Compress"}
            />
            {result && <DownloadCard result={result} />}
            {targetMode && busy && (
              <p className="text-xs text-muted">
                Trying compression levels in sequence — this can take a minute
                on large PDFs.
              </p>
            )}
          </SidePanel>
        </div>
      )}
    </div>
  );
}

function SizeBlock({ label, bytes, accent }: { label: string; bytes: number; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-lg font-semibold ${accent ? "text-emerald-300" : "text-white"}`}>
        {humanBytes(bytes)}
      </div>
    </div>
  );
}
