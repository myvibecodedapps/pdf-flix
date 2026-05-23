import { useState } from "react";
import { useDropzone } from "react-dropzone";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Combine, FileText, GripVertical, Plus, Trash2 } from "lucide-react";
import { humanBytes, mergePdfs, uuid } from "../lib/api";
import { DownloadCard, Header, RunButton, SidePanel } from "./SplitTool";

type Item = { id: string; file: File };

export default function MergeTool() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ download: string; filename: string } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // One dropzone for the initial drop area, one for "Add more" — keeping them
  // separate avoids react-dropzone's `noClick` from disabling the inline button.
  const initialZone = useDropzone({
    onDrop: (files) => addFiles(files),
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
  });
  const addMoreZone = useDropzone({
    onDrop: (files) => addFiles(files),
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
  });

  function addFiles(files: File[]) {
    setItems((prev) => [
      ...prev,
      ...files.map((f) => ({ id: uuid(), file: f })),
    ]);
    setResult(null);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const oldIdx = prev.findIndex((i) => i.id === active.id);
      const newIdx = prev.findIndex((i) => i.id === over.id);
      return arrayMove(prev, oldIdx, newIdx);
    });
  }

  async function run() {
    if (items.length < 2) { setError("Add at least 2 PDFs."); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await mergePdfs(items.map((i) => i.file)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Header title="Merge" />

      {items.length === 0 && (
        <div
          {...initialZone.getRootProps()}
          className={`rounded-xl border-2 border-dashed cursor-pointer transition-colors p-10 text-center min-h-[220px] flex flex-col items-center justify-center
            ${initialZone.isDragActive ? "border-accent bg-accent/5" : "border-white/15 bg-panel/40 hover:border-white/30"}`}
        >
          <input {...initialZone.getInputProps()} />
          <div className="w-12 h-12 rounded-full bg-accent/15 flex items-center justify-center mb-3">
            <Combine className="w-6 h-6 text-accent" />
          </div>
          <p className="font-medium mb-1">Drop PDFs to merge</p>
          <p className="text-xs text-muted">Drag to reorder before merging</p>
        </div>
      )}

      {items.length > 0 && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div className="min-w-0">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
                <ul className="space-y-2">
                  {items.map((it, idx) => (
                    <SortableRow
                      key={it.id}
                      item={it}
                      index={idx}
                      onRemove={() => setItems((prev) => prev.filter((p) => p.id !== it.id))}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>

            <button
              type="button"
              onClick={addMoreZone.open}
              className="mt-3 flex items-center gap-2 text-sm text-muted hover:text-white border border-dashed border-white/15 hover:border-white/30 rounded-md px-4 py-2.5 w-full justify-center transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add more
            </button>
            {/* Hidden file input controlled by the "Add more" button */}
            <input {...addMoreZone.getInputProps()} />
          </div>

          <SidePanel error={error}>
            <div className="text-xs text-muted">
              <span className="text-white font-semibold">{items.length}</span> file{items.length === 1 ? "" : "s"} ·{" "}
              {humanBytes(items.reduce((a, b) => a + b.file.size, 0))}
            </div>
            <RunButton onClick={run} busy={busy} icon={<Combine className="w-4 h-4" />} label="Merge" />
            {result && <DownloadCard result={result} />}
          </SidePanel>
        </div>
      )}
    </div>
  );
}

function SortableRow({
  item, index, onRemove,
}: {
  item: Item;
  index: number;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 bg-panel border border-white/5 rounded-lg px-3.5 py-2.5 hover:border-white/15 transition-colors"
    >
      <button
        {...attributes}
        {...listeners}
        className="text-muted hover:text-white cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="w-6 h-6 rounded bg-accent/15 text-accent text-xs font-bold flex items-center justify-center">
        {index + 1}
      </div>
      <FileText className="w-4 h-4 text-muted shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{item.file.name}</div>
        <div className="text-xs text-muted">{humanBytes(item.file.size)}</div>
      </div>
      <button onClick={onRemove} className="text-muted hover:text-red-400 p-1" aria-label="Remove">
        <Trash2 className="w-4 h-4" />
      </button>
    </li>
  );
}
