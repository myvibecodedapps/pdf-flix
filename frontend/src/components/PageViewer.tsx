import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { pageUrl } from "../lib/api";

export default function PageViewer({
  jobId,
  totalPages,
  initialPage,
  onClose,
}: {
  jobId: string;
  totalPages: number;
  initialPage: number;
  onClose: () => void;
}) {
  const [page, setPage] = useState(initialPage);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => setLoaded(false), [page]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setPage((p) => Math.max(1, p - 1));
      else if (e.key === "ArrowRight") setPage((p) => Math.min(totalPages, p + 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [totalPages, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-label={`Page ${page} of ${totalPages}`}
    >
      <button
        onClick={onClose}
        style={{
          top: "max(1rem, env(safe-area-inset-top))",
          right: "max(1rem, env(safe-area-inset-right))",
        }}
        className="absolute w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"
        aria-label="Close"
      >
        <X className="w-5 h-5" />
      </button>

      <div
        style={{
          top: "max(1rem, env(safe-area-inset-top))",
          left: "max(1rem, env(safe-area-inset-left))",
        }}
        className="absolute text-sm text-white/70 bg-black/40 rounded-full px-3 py-1.5"
      >
        {page} / {totalPages}
      </div>

      {page > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); setPage((p) => Math.max(1, p - 1)); }}
          className="absolute left-2 sm:left-6 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 flex items-center justify-center"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      )}
      {page < totalPages && (
        <button
          onClick={(e) => { e.stopPropagation(); setPage((p) => Math.min(totalPages, p + 1)); }}
          className="absolute right-2 sm:right-6 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 flex items-center justify-center"
          aria-label="Next page"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}

      <div
        className="relative max-w-[90vw] max-h-[90vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
            Loading…
          </div>
        )}
        <img
          src={pageUrl(jobId, page, 1600)}
          alt={`Page ${page}`}
          onLoad={() => setLoaded(true)}
          className={`max-w-[90vw] max-h-[90vh] object-contain rounded-md shadow-2xl transition-opacity ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
          draggable={false}
        />
      </div>
    </div>
  );
}
