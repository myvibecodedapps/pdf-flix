import { useState } from "react";
import { Scissors, Combine, ListOrdered, ScanText, Shrink, Lock, ArrowLeft } from "lucide-react";
import SplitTool from "./components/SplitTool";
import MergeTool from "./components/MergeTool";
import ReorderTool from "./components/ReorderTool";
import OcrTool from "./components/OcrTool";
import CompressTool from "./components/CompressTool";

export type ToolId = "home" | "split" | "merge" | "reorder" | "ocr" | "compress";

const TOOLS = [
  { id: "split" as const,    title: "Split",    icon: Scissors },
  { id: "merge" as const,    title: "Merge",    icon: Combine },
  { id: "reorder" as const,  title: "Reorder",  icon: ListOrdered },
  { id: "compress" as const, title: "Compress", icon: Shrink },
  { id: "ocr" as const,      title: "OCR",      icon: ScanText },
];

export default function App() {
  const [tool, setTool] = useState<ToolId>("home");

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-white/5">
        <div className="max-w-5xl mx-auto flex items-center gap-4 px-6 py-3">
          <button
            onClick={() => setTool("home")}
            className="font-bold tracking-tight text-lg hover:text-accent transition-colors"
          >
            PDFflix
          </button>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
            <Lock className="w-3 h-3" />
            All local · No cloud · Full privacy
          </span>
        </div>
      </header>

      <main className="flex-1">
        {tool === "home" ? (
          <Home onPick={setTool} />
        ) : (
          <div className="max-w-5xl mx-auto px-6 pt-6 pb-16">
            <button
              onClick={() => setTool("home")}
              className="text-sm text-muted hover:text-white mb-6 flex items-center gap-1.5"
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            {tool === "split" && <SplitTool />}
            {tool === "merge" && <MergeTool />}
            {tool === "reorder" && <ReorderTool />}
            {tool === "compress" && <CompressTool />}
            {tool === "ocr" && <OcrTool />}
          </div>
        )}
      </main>
    </div>
  );
}

function Home({ onPick }: { onPick: (t: ToolId) => void }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16 sm:py-24">
      <div className="text-center mb-12">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">PDFflix</h1>
        <p className="text-muted mt-3">All local · No cloud · Full privacy</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 sm:gap-4">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => onPick(t.id)}
              className="aspect-square flex flex-col items-center justify-center gap-3 bg-panel hover:bg-panel2 border border-white/5 hover:border-accent rounded-xl transition-colors group"
            >
              <Icon className="w-8 h-8 text-muted group-hover:text-accent transition-colors" />
              <span className="text-sm font-medium">{t.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
