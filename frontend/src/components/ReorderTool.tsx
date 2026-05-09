import { useState } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, ListOrdered, RotateCcw, Trash2 } from "lucide-react";
import FileDrop from "./FileDrop";
import PageThumb from "./PageThumb";
import PageViewer from "./PageViewer";
import { reorderJob, uploadPdf, uuid, type Job } from "../lib/api";
import { DownloadCard, FileBadge, Header, RunButton, SidePanel } from "./SplitTool";

type Slot = { id: string; page: number };

export default function ReorderTool() {
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [result, setResult] = useState<{ download: string; filename: string } | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function onUpload(files: File[]) {
    if (!files[0]) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const j = await uploadPdf(files[0], setProgress);
      setJob(j);
      setSlots(Array.from({ length: j.pages }, (_, i) => ({
        id: uuid(),
        page: i + 1,
      })));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false); setProgress(0);
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setSlots((prev) => {
      const oldIdx = prev.findIndex((p) => p.id === active.id);
      const newIdx = prev.findIndex((p) => p.id === over.id);
      return arrayMove(prev, oldIdx, newIdx);
    });
  }

  async function run() {
    if (!job || slots.length === 0) return;
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await reorderJob(job.job_id, slots.map((s) => s.page)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (!job) return;
    setSlots(Array.from({ length: job.pages }, (_, i) => ({
      id: uuid(),
      page: i + 1,
    })));
    setResult(null);
  }

  function removeSlot(id: string) {
    setSlots((prev) => prev.filter((p) => p.id !== id));
  }
  function duplicateSlot(slot: Slot) {
    setSlots((prev) => {
      const idx = prev.findIndex((p) => p.id === slot.id);
      const copy = { id: uuid(), page: slot.page };
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
    });
  }

  return (
    <div>
      <Header title="Reorder" />

      {!job && <FileDrop onFiles={onUpload} busy={busy} progress={progress} />}

      {job && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div>
            <FileBadge job={job} onClear={() => { setJob(null); setSlots([]); setResult(null); }} />

            <div className="flex items-center gap-3 mb-4">
              <button
                onClick={reset}
                className="flex items-center gap-1.5 text-xs text-muted hover:text-white border border-white/10 px-3 py-1.5 rounded-md hover:border-white/30 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </button>
              <span className="text-xs text-muted">
                {slots.length} of {job.pages} page{job.pages === 1 ? "" : "s"}
              </span>
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={slots.map((s) => s.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2.5">
                  {slots.map((s, i) => (
                    <Tile
                      key={s.id}
                      slot={s}
                      jobId={job.job_id}
                      pos={i + 1}
                      onRemove={() => removeSlot(s.id)}
                      onDuplicate={() => duplicateSlot(s)}
                      onView={() => setViewing(s.page)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>

          <SidePanel error={error}>
            <RunButton onClick={run} busy={busy} icon={<ListOrdered className="w-4 h-4" />} label="Apply" />
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

function Tile({
  slot, jobId, pos, onRemove, onDuplicate, onView,
}: {
  slot: Slot;
  jobId: string;
  pos: number;
  onRemove: () => void;
  onDuplicate: () => void;
  onView: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: slot.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative group touch-none">
      <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">
        <PageThumb jobId={jobId} page={slot.page} onView={onView} />
      </div>

      <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/70 text-[10px] font-bold tracking-wide">
        {pos}
      </div>

      <div className="absolute bottom-7 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onDuplicate}
          className="bg-black/70 hover:bg-accent rounded p-1"
          aria-label="Duplicate"
          title="Duplicate"
        >
          <Copy className="w-3 h-3" />
        </button>
        <button
          onClick={onRemove}
          className="bg-black/70 hover:bg-red-600 rounded p-1"
          aria-label="Remove"
          title="Remove"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
