import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { thumbUrl } from "../lib/api";

export default function PageThumb({
  jobId,
  page,
  selected,
  onView,
  className = "",
}: {
  jobId: string;
  page: number;
  selected?: boolean;
  onView?: () => void;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [src] = useState(() => thumbUrl(jobId, page));

  useEffect(() => {
    setLoaded(false);
  }, [src]);

  return (
    <div
      className={`relative rounded-md overflow-hidden bg-panel2 ring-1 transition-all ${
        selected ? "ring-2 ring-accent" : "ring-white/10"
      } ${className}`}
      style={{ aspectRatio: "0.77 / 1" }}
    >
      {!loaded && <div className="absolute inset-0 skeleton" />}
      <img
        src={src}
        alt={`Page ${page}`}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={`w-full h-full object-contain transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
        draggable={false}
      />
      {onView && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onView(); }}
          className="absolute top-1 right-1 w-7 h-7 rounded-full bg-black/70 hover:bg-accent flex items-center justify-center opacity-0 hover:opacity-100 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          aria-label={`View page ${page}`}
          title="View"
        >
          <Eye className="w-3.5 h-3.5" />
        </button>
      )}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent text-[11px] text-white px-2 py-1 font-medium">
        {page}
      </div>
    </div>
  );
}
