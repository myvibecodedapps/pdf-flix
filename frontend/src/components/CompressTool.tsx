import { useState } from "react";
import { Shrink, ArrowRight, Info } from "lucide-react";
import FileDrop from "./FileDrop";
import { compressJob, humanBytes, uploadPdf, type Job } from "../lib/api";
import { DownloadCard, FileBadge, Header, RunButton, SidePanel } from "./SplitTool";

type Level = "strong" | "medium" | "light" | "minimal";

const LEVELS: { id: Level; label: string; sub: string }[] = [
  { id: "strong",  label: "Strong",  sub: "~72 dpi · smallest file" },
  { id: "medium",  label: "Medium",  sub: "~150 dpi · balanced" },
  { id: "light",   label: "Light",   sub: "~300 dpi · print quality" },
  { id: "minimal", label: "Minimal", sub: "~300 dpi · near-original" },
];

type Result = {
  download: string;
  filename: string;
  level: string;
  level_label: string;
  original_size: number;
  new_size: number;
  saved_bytes: number;
  ratio_percent: number;
  notice?: string | null;
};

export default function CompressTool() {
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("medium");
  const [result, setResult] = useState<Result | null>(null);

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
      setResult(await compressJob(job.job_id, level));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Header title="Compress" />

      {!job && <FileDrop onFiles={onUpload} busy={busy} progress={progress} />}

      {job && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div className="space-y-4 min-w-0">
            <FileBadge job={job} onClear={() => { setJob(null); setResult(null); }} />

            <div className="bg-panel/60 border border-white/5 rounded-lg p-4 space-y-3">
              <div className="text-xs uppercase tracking-wider text-muted">
                Compression level
              </div>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value as Level)}
                className="w-full bg-panel2 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent"
              >
                {LEVELS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label} — {l.sub}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted">
                Stronger compression shrinks images more (lower DPI). Text-heavy
                PDFs may not shrink much.
              </p>
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
                <div className="text-xs uppercase tracking-wider text-muted mb-3">
                  Result · {result.level_label} compression
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
              </div>
            )}
          </div>

          <SidePanel error={error}>
            <RunButton onClick={run} busy={busy} icon={<Shrink className="w-4 h-4" />} label="Compress" />
            {result && <DownloadCard result={result} />}
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
