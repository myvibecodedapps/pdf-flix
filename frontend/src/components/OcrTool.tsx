import { useState } from "react";
import { ScanText, FileText, Info } from "lucide-react";
import FileDrop from "./FileDrop";
import { ocrJob, uploadPdf, type Job } from "../lib/api";
import { DownloadCard, FileBadge, Header, RunButton, SidePanel } from "./SplitTool";

type Output = "pdf" | "text" | "both";

const LANGUAGES: { code: string; name: string }[] = [
  { code: "eng", name: "English" },
  { code: "spa", name: "Spanish" },
  { code: "fra", name: "French" },
  { code: "deu", name: "German" },
  { code: "ita", name: "Italian" },
  { code: "por", name: "Portuguese" },
  { code: "nld", name: "Dutch" },
  { code: "rus", name: "Russian" },
  { code: "ara", name: "Arabic" },
  { code: "hin", name: "Hindi" },
  { code: "chi_sim", name: "Chinese (Simplified)" },
  { code: "jpn", name: "Japanese" },
];

const OUTPUTS: { id: Output; label: string; sub: string }[] = [
  { id: "pdf", label: "Searchable PDF", sub: "PDF with selectable text" },
  { id: "text", label: "Plain text", sub: ".txt file" },
  { id: "both", label: "Both", sub: "PDF + text in a zip" },
];

export default function OcrTool() {
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [output, setOutput] = useState<Output>("pdf");
  const [language, setLanguage] = useState("eng");

  const [result, setResult] = useState<{ download: string; filename: string; preview?: string; notice?: string | null } | null>(null);

  async function onUpload(files: File[]) {
    if (!files[0]) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const j = await uploadPdf(files[0], setProgress);
      setJob(j);
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
      // Always force-OCR. Defaulting to skip-text preserved bad/junk text
      // layers, which is the wrong behavior for a tool called "OCR".
      setResult(await ocrJob(job.job_id, output, language, true));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Header title="OCR" />

      {!job && <FileDrop onFiles={onUpload} busy={busy} progress={progress} />}

      {job && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div className="space-y-4 min-w-0">
            <FileBadge job={job} onClear={() => { setJob(null); setResult(null); }} />

            <div className="bg-panel/60 border border-white/5 rounded-lg p-4 space-y-4">
              <Field label="Output">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {OUTPUTS.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => setOutput(o.id)}
                      className={`text-left p-3 rounded-md border transition-colors ${
                        output === o.id
                          ? "border-accent bg-accent/10"
                          : "border-white/10 hover:border-white/30"
                      }`}
                    >
                      <div className="text-sm font-medium">{o.label}</div>
                      <div className="text-xs text-muted mt-0.5">{o.sub}</div>
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Language">
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="bg-panel2 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.name}</option>
                  ))}
                </select>
              </Field>

            </div>

            {result?.notice && (
              <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 min-w-0">
                <Info className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 text-sm text-amber-100/90 break-words">
                  {result.notice}
                </div>
              </div>
            )}

            {result && <DownloadCard result={result} />}

            {result?.preview && (
              <div className="bg-panel/60 border border-white/5 rounded-lg p-4 min-w-0">
                <div className="font-medium mb-2 flex items-center gap-2 text-sm">
                  <FileText className="w-4 h-4 text-accent" /> Text preview
                </div>
                <pre
                  className="text-xs bg-panel2 rounded p-3 max-h-80 overflow-y-auto overflow-x-hidden whitespace-pre-wrap leading-relaxed text-white/80"
                  style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                >
                  {result.preview}
                </pre>
              </div>
            )}
          </div>

          <SidePanel error={error}>
            <RunButton onClick={run} busy={busy} icon={<ScanText className="w-4 h-4" />} label="Run OCR" />
          </SidePanel>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted mb-2">{label}</div>
      {children}
    </div>
  );
}
