// Same-origin in production (frontend served by FastAPI). Vite dev proxies /api.
const BASE = "";

export type Job = {
  job_id: string;
  filename: string;
  pages: number;
  title: string;
  size_bytes: number;
};

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, init);
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = j.detail || msg;
    } catch {}
    throw new Error(`${r.status}: ${msg}`);
  }
  return r.json() as Promise<T>;
}

export async function uploadPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<Job> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", BASE + "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(e);
        }
      } else {
        let msg = xhr.statusText;
        try {
          msg = JSON.parse(xhr.responseText).detail ?? msg;
        } catch {}
        reject(new Error(`${xhr.status}: ${msg}`));
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(fd);
  });
}

export async function mergePdfs(files: File[]): Promise<{ job_id: string; download: string; filename: string }> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  return jfetch("/api/merge", { method: "POST", body: fd });
}

export async function splitJob(jobId: string, ranges: string, mode: "zip" | "combined" = "zip") {
  const fd = new FormData();
  fd.append("ranges", ranges);
  fd.append("mode", mode);
  return jfetch<{ download: string; filename: string }>(
    `/api/jobs/${jobId}/split`,
    { method: "POST", body: fd },
  );
}

export async function reorderJob(jobId: string, order: number[]) {
  const fd = new FormData();
  fd.append("order", JSON.stringify(order));
  return jfetch<{ download: string; filename: string }>(
    `/api/jobs/${jobId}/reorder`,
    { method: "POST", body: fd },
  );
}

export type CompressResult = {
  download: string;
  filename: string;
  level: string;
  level_label: string;
  original_size: number;
  new_size: number;
  saved_bytes: number;
  ratio_percent: number;
  target_bytes?: number;
  attempts?: { label: string; size: number | null; fits?: boolean; error?: string }[];
  notice?: string | null;
};

export async function compressJob(jobId: string, level: string, targetMb?: number) {
  const fd = new FormData();
  fd.append("level", level);
  if (targetMb && targetMb > 0) fd.append("target_mb", String(targetMb));
  return jfetch<CompressResult>(`/api/jobs/${jobId}/compress`, { method: "POST", body: fd });
}

export async function ocrJob(
  jobId: string,
  output: "pdf" | "text" | "both",
  language = "eng",
  force = false,
) {
  const fd = new FormData();
  fd.append("output", output);
  fd.append("language", language);
  fd.append("force", String(force));
  return jfetch<{ download: string; filename: string; preview?: string; notice?: string | null }>(
    `/api/jobs/${jobId}/ocr`,
    { method: "POST", body: fd },
  );
}

export function thumbUrl(jobId: string, page: number) {
  return `${BASE}/api/jobs/${jobId}/thumb/${page}`;
}

export function pageUrl(jobId: string, page: number, width = 1400) {
  return `${BASE}/api/jobs/${jobId}/page/${page}?w=${width}`;
}

export function downloadUrl(path: string, filename?: string) {
  return BASE + path + (filename ? `?download=${encodeURIComponent(filename)}` : "");
}

export async function deleteJob(jobId: string) {
  return jfetch(`/api/jobs/${jobId}`, { method: "DELETE" });
}

// crypto.randomUUID is only defined in secure contexts (HTTPS / localhost).
// On http://raspberrypi5.local it's undefined — fall back to a Math.random id.
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function") {
    return (crypto as any).randomUUID();
  }
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export function humanBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
