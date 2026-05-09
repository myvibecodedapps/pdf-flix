import { useDropzone } from "react-dropzone";
import { Upload, FileText } from "lucide-react";
import { humanBytes } from "../lib/api";

export default function FileDrop({
  onFiles,
  multiple = false,
  hint,
  busy,
  progress,
}: {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  hint?: string;
  busy?: boolean;
  progress?: number;
}) {
  const { getRootProps, getInputProps, isDragActive, acceptedFiles } = useDropzone({
    onDrop: (files) => onFiles(files),
    accept: { "application/pdf": [".pdf"] },
    multiple,
    disabled: busy,
  });

  return (
    <div
      {...getRootProps()}
      className={`relative rounded-xl border-2 border-dashed transition-colors cursor-pointer
        ${isDragActive ? "border-accent bg-accent/5" : "border-white/15 bg-panel/40 hover:border-white/30"}
        ${busy ? "opacity-70 cursor-wait" : ""}
        p-10 flex flex-col items-center justify-center text-center min-h-[220px]`}
    >
      <input {...getInputProps()} />
      <div className="w-12 h-12 rounded-full bg-accent/15 flex items-center justify-center mb-3">
        <Upload className="w-6 h-6 text-accent" />
      </div>
      <p className="font-medium mb-1">
        {isDragActive ? "Drop here" : multiple ? "Drop PDFs or click to choose" : "Drop a PDF or click to choose"}
      </p>
      <p className="text-xs text-muted">{hint ?? "PDF · up to 500 MB"}</p>

      {busy && progress !== undefined && (
        <div className="absolute left-6 right-6 bottom-6">
          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="text-xs text-muted mt-2">Uploading… {Math.round(progress * 100)}%</div>
        </div>
      )}

      {acceptedFiles.length > 0 && multiple && !busy && (
        <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2 text-left w-full max-w-2xl">
          {acceptedFiles.slice(0, 8).map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-sm text-white/80 bg-panel rounded px-3 py-2">
              <FileText className="w-4 h-4 text-accent" />
              <span className="truncate">{f.name}</span>
              <span className="ml-auto text-muted text-xs">{humanBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
