"""PDFflix backend — split, merge, reorder, OCR.

Stateless-ish: every upload becomes a job_id under JOBS_DIR. Outputs are
written under the same dir and streamed on download. A janitor task evicts
jobs older than JOB_TTL_SEC.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

import fitz  # PyMuPDF
import pikepdf
from fastapi import FastAPI, File, Form, HTTPException, Path as PathParam, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

log = logging.getLogger("pdfflix")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

ROOT = Path(__file__).parent.resolve()
JOBS_DIR = Path(os.environ.get("PDFFLIX_JOBS_DIR", "/tmp/pdfflix-jobs"))
STATIC_DIR = Path(os.environ.get("PDFFLIX_STATIC_DIR", str(ROOT / "static")))
JOB_TTL_SEC = int(os.environ.get("PDFFLIX_JOB_TTL", "3600"))  # 1 hour
MAX_UPLOAD_MB = int(os.environ.get("PDFFLIX_MAX_UPLOAD_MB", "500"))

JOBS_DIR.mkdir(parents=True, exist_ok=True)


# ---------- helpers ----------

def _safe_job_dir(job_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9-]{8,64}", job_id):
        raise HTTPException(400, "bad job id")
    p = JOBS_DIR / job_id
    if not p.exists() or not p.is_dir():
        raise HTTPException(404, "job not found")
    return p


def _new_job() -> tuple[str, Path]:
    jid = uuid.uuid4().hex
    p = JOBS_DIR / jid
    p.mkdir(parents=True, exist_ok=False)
    return jid, p


def _ts() -> str:
    """Local-time stamp safe in filenames. Sorts lexicographically by time and
    keeps repeated outputs of the same operation from colliding."""
    return time.strftime("%Y%m%d-%H%M%S")


async def _save_upload(file: UploadFile, dest: Path, max_mb: int = MAX_UPLOAD_MB) -> int:
    written = 0
    limit = max_mb * 1024 * 1024
    with dest.open("wb") as f:
        while True:
            chunk = await file.read(1 << 20)  # 1 MiB
            if not chunk:
                break
            written += len(chunk)
            if written > limit:
                f.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"file > {max_mb} MB")
            f.write(chunk)
    return written


def _meta_for(pdf_path: Path) -> dict:
    doc = fitz.open(pdf_path)
    try:
        return {
            "pages": doc.page_count,
            "title": (doc.metadata or {}).get("title") or pdf_path.stem,
            "size_bytes": pdf_path.stat().st_size,
        }
    finally:
        doc.close()


def _parse_ranges(spec: str, total: int) -> List[List[int]]:
    """'1-3,5,7-9' -> [[1,2,3],[5],[7,8,9]] (1-indexed input, validates bounds)."""
    out: List[List[int]] = []
    for grp in spec.split(","):
        grp = grp.strip()
        if not grp:
            continue
        if "-" in grp:
            a, b = grp.split("-", 1)
            i, j = int(a), int(b)
        else:
            i = j = int(grp)
        if i < 1 or j < 1 or i > total or j > total or i > j:
            raise HTTPException(400, f"invalid range '{grp}' (doc has {total} pages)")
        out.append(list(range(i, j + 1)))
    if not out:
        raise HTTPException(400, "empty range spec")
    return out


# ---------- lifespan ----------

@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = asyncio.Event()

    async def janitor():
        while not stop.is_set():
            try:
                cutoff = time.time() - JOB_TTL_SEC
                for d in JOBS_DIR.iterdir():
                    if d.is_dir() and d.stat().st_mtime < cutoff:
                        shutil.rmtree(d, ignore_errors=True)
                        log.info("janitor: evicted %s", d.name)
            except Exception as e:  # noqa: BLE001
                log.warning("janitor error: %s", e)
            try:
                await asyncio.wait_for(stop.wait(), timeout=300)
            except asyncio.TimeoutError:
                pass

    task = asyncio.create_task(janitor())
    try:
        yield
    finally:
        stop.set()
        await task


app = FastAPI(title="PDFflix", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---------- API ----------

@app.get("/api/health")
async def health():
    return {"ok": True, "max_upload_mb": MAX_UPLOAD_MB}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "only .pdf accepted")
    jid, jdir = _new_job()
    src = jdir / "input.pdf"
    size = await _save_upload(file, src)
    try:
        meta = _meta_for(src)
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(jdir, ignore_errors=True)
        raise HTTPException(400, f"could not parse PDF: {e}")
    (jdir / "meta.json").write_text(json.dumps({"filename": file.filename, **meta}))
    return {"job_id": jid, "filename": file.filename, **meta, "size_bytes": size}


@app.get("/api/jobs/{job_id}/thumb/{page}")
async def thumb(job_id: str, page: int = PathParam(..., ge=1)):
    """Render a single-page JPEG thumbnail (~130px wide). Cached on disk."""
    return _render_page_jpeg(job_id, page, target_w=130, quality=78)


@app.get("/api/jobs/{job_id}/page/{page}")
async def page_image(job_id: str, page: int = PathParam(..., ge=1), w: int = 1400):
    """Render a single page at a chosen width (capped). For the lightbox viewer."""
    w = max(400, min(w, 2400))
    return _render_page_jpeg(job_id, page, target_w=w, quality=85)


def _render_page_jpeg(job_id: str, page: int, target_w: int, quality: int) -> FileResponse:
    jdir = _safe_job_dir(job_id)
    cache = jdir / f"render_w{target_w}_p{page}.jpg"
    if not cache.exists():
        src = jdir / "input.pdf"
        if not src.exists():
            raise HTTPException(404, "input missing")
        doc = fitz.open(src)
        try:
            if page > doc.page_count:
                raise HTTPException(404, "page out of range")
            pg = doc.load_page(page - 1)
            zoom = target_w / max(pg.rect.width, 1)
            pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            pix.save(cache, jpg_quality=quality)
        finally:
            doc.close()
    return FileResponse(cache, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})


@app.post("/api/jobs/{job_id}/split")
async def split(job_id: str, ranges: str = Form(...), mode: str = Form("zip")):
    """Split.

    mode = "zip"      → one PDF per range, bundled in a zip (or a single PDF when there's only one range)
    mode = "combined" → flatten all ranges into one PDF (used by "Pick pages")
    """
    jdir = _safe_job_dir(job_id)
    src = jdir / "input.pdf"
    meta = json.loads((jdir / "meta.json").read_text())
    groups = _parse_ranges(ranges, meta["pages"])
    base = Path(meta["filename"]).stem
    ts = _ts()

    if mode == "combined":
        # All selected pages, in input order, into a single PDF.
        out = jdir / f"pages-{ts}.pdf"
        with pikepdf.open(src) as pdf, pikepdf.new() as new_pdf:
            for pages in groups:
                for p in pages:
                    new_pdf.pages.append(pdf.pages[p - 1])
            new_pdf.save(out)
        return {
            "download": f"/api/jobs/{job_id}/download/{out.name}",
            "filename": f"{base}-pages-{ts}.pdf",
        }

    # zip mode
    out_files: list[Path] = []
    with pikepdf.open(src) as pdf:
        for idx, pages in enumerate(groups, 1):
            out = jdir / f"part-{ts}-{idx:03d}.pdf"
            with pikepdf.new() as new_pdf:
                for p in pages:
                    new_pdf.pages.append(pdf.pages[p - 1])
                new_pdf.save(out)
            out_files.append(out)

    if len(out_files) == 1:
        return {
            "download": f"/api/jobs/{job_id}/download/{out_files[0].name}",
            "filename": f"{base}-pages-{ts}.pdf",
        }

    bundle = jdir / f"split-{ts}.zip"
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, f in enumerate(out_files, 1):
            zf.write(f, arcname=f"{base}-part-{i:03d}.pdf")
    return {
        "download": f"/api/jobs/{job_id}/download/{bundle.name}",
        "filename": f"{base}-split-{ts}.zip",
    }


@app.post("/api/merge")
async def merge(files: List[UploadFile] = File(...)):
    """Multi-upload merge: ordered by upload order."""
    if len(files) < 2:
        raise HTTPException(400, "need at least 2 PDFs")
    jid, jdir = _new_job()
    saved: list[Path] = []
    for i, f in enumerate(files):
        if not f.filename or not f.filename.lower().endswith(".pdf"):
            raise HTTPException(400, f"file {i} not pdf")
        p = jdir / f"in_{i:03d}.pdf"
        await _save_upload(f, p)
        saved.append(p)
    ts = _ts()
    out = jdir / f"merged-{ts}.pdf"
    with pikepdf.new() as new_pdf:
        for p in saved:
            with pikepdf.open(p) as src:
                new_pdf.pages.extend(src.pages)
        new_pdf.save(out)
    return {
        "job_id": jid,
        "download": f"/api/jobs/{jid}/download/{out.name}",
        "filename": out.name,
    }


_COMPRESS_LEVELS = {
    # Ghostscript PDFSETTINGS presets, mapped to human labels for the UI.
    # Lower preset = smaller file = lower quality.
    "strong":  ("/screen",   "Strong",  "~72 dpi · smallest file"),
    "medium":  ("/ebook",    "Medium",  "~150 dpi · balanced"),
    "light":   ("/printer",  "Light",   "~300 dpi · print quality"),
    "minimal": ("/prepress", "Minimal", "~300 dpi · near-original"),
}


@app.post("/api/jobs/{job_id}/compress")
async def compress(job_id: str, level: str = Form("medium")):
    """Reduce PDF size with Ghostscript. level ∈ strong|medium|light|minimal."""
    jdir = _safe_job_dir(job_id)
    src = jdir / "input.pdf"
    if not src.exists():
        raise HTTPException(404, "input missing")
    if level not in _COMPRESS_LEVELS:
        raise HTTPException(400, f"invalid level (got {level!r})")

    gs_setting, label, _ = _COMPRESS_LEVELS[level]
    meta = json.loads((jdir / "meta.json").read_text())
    base = Path(meta["filename"]).stem
    ts = _ts()
    out = jdir / f"compressed-{level}-{ts}.pdf"

    cmd = [
        "gs",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        f"-dPDFSETTINGS={gs_setting}",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dDetectDuplicateImages=true",
        "-dCompressFonts=true",
        f"-sOutputFile={out}",
        str(src),
    ]
    log.info("compress cmd: %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await proc.communicate()
    if proc.returncode != 0 or not out.exists():
        log.error("compress failed: %s", stderr.decode("utf-8", "replace")[-2000:])
        raise HTTPException(500, f"compress failed: {stderr.decode('utf-8','replace')[-400:]}")

    original_size = src.stat().st_size
    new_size = out.stat().st_size
    saved = max(0, original_size - new_size)
    ratio = round((saved / original_size) * 100, 1) if original_size else 0.0

    notice: Optional[str] = None
    if new_size >= original_size:
        notice = (
            "The compressed file is the same size or larger than the original — "
            "this PDF is already heavily compressed, or contains mostly vector / "
            "text content that can't shrink further. Try a stronger level, or "
            "keep the original."
        )

    return {
        "download": f"/api/jobs/{job_id}/download/{out.name}",
        "filename": f"{base}-compressed-{level}-{ts}.pdf",
        "level": level,
        "level_label": label,
        "original_size": original_size,
        "new_size": new_size,
        "saved_bytes": saved,
        "ratio_percent": ratio,
        "notice": notice,
    }


@app.post("/api/jobs/{job_id}/reorder")
async def reorder(job_id: str, order: str = Form(...)):
    """order = JSON list of 1-indexed page numbers (may include duplicates / subset)."""
    jdir = _safe_job_dir(job_id)
    src = jdir / "input.pdf"
    meta = json.loads((jdir / "meta.json").read_text())
    try:
        seq = json.loads(order)
        assert isinstance(seq, list) and all(isinstance(x, int) for x in seq)
    except Exception:
        raise HTTPException(400, "order must be JSON list of ints")
    if not seq:
        raise HTTPException(400, "empty order")
    for x in seq:
        if x < 1 or x > meta["pages"]:
            raise HTTPException(400, f"page {x} out of range")
    ts = _ts()
    out = jdir / f"reordered-{ts}.pdf"
    with pikepdf.open(src) as pdf, pikepdf.new() as new_pdf:
        for x in seq:
            new_pdf.pages.append(pdf.pages[x - 1])
        new_pdf.save(out)
    base = Path(meta["filename"]).stem
    return {
        "download": f"/api/jobs/{job_id}/download/{out.name}",
        "filename": f"{base}-reordered-{ts}.pdf",
    }


@app.post("/api/jobs/{job_id}/ocr")
async def ocr(
    job_id: str,
    output: str = Form("pdf"),  # pdf | text | both
    language: str = Form("eng"),
    force: bool = Form(False),
):
    """Run OCR. output=pdf returns searchable PDF; text returns .txt; both returns .zip."""
    jdir = _safe_job_dir(job_id)
    src = jdir / "input.pdf"
    if not src.exists():
        raise HTTPException(404, "input missing")
    meta = json.loads((jdir / "meta.json").read_text())
    base = Path(meta["filename"]).stem
    ts = _ts()

    out_pdf = jdir / f"ocr-{ts}.pdf"
    sidecar = jdir / f"ocr-{ts}.txt"

    cmd = [
        "ocrmypdf",
        "-l", language,
        "--sidecar", str(sidecar),
        "--output-type", "pdf",
        "--optimize", "1",
        "--jobs", str(max(1, os.cpu_count() or 2)),
    ]
    if force:
        cmd.append("--force-ocr")
    else:
        cmd.append("--skip-text")  # don't redo pages that already have text
    cmd += [str(src), str(out_pdf)]

    log.info("ocr cmd: %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        log.error("ocr failed: %s", stderr.decode("utf-8", "replace")[-2000:])
        raise HTTPException(500, f"ocr failed: {stderr.decode('utf-8', 'replace')[-400:]}")

    # If ocrmypdf skipped pages because they already have a text layer,
    # the sidecar is a placeholder like "[OCR skipped on page(s) 1-12]".
    # In that case (or any partial-skip), splice in the existing text layer
    # so a .txt download is always actually useful.
    skipped_pages, sidecar_text = _augment_sidecar_with_extracted_text(out_pdf, sidecar)
    notice: Optional[str] = None
    if skipped_pages:
        if skipped_pages == "all":
            notice = (
                "This PDF already has a searchable text layer on every page, so OCR "
                "had nothing to do. The .txt download contains the existing text. "
                "Enable “Force OCR” to re-recognize the pages from scratch."
            )
        else:
            notice = (
                f"OCR skipped {skipped_pages} (already had a text layer). The remaining "
                "pages were OCR'd. Existing text was merged into the .txt download."
            )

    preview = sidecar_text[:5000]

    if output == "text":
        return {
            "download": f"/api/jobs/{job_id}/download/{sidecar.name}",
            "filename": f"{base}-ocr-{ts}.txt",
            "preview": preview,
            "notice": notice,
        }
    if output == "both":
        bundle = jdir / f"ocr-{ts}.zip"
        with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(out_pdf, arcname=f"{base}-ocr.pdf")
            if sidecar.exists():
                zf.write(sidecar, arcname=f"{base}-ocr.txt")
        return {
            "download": f"/api/jobs/{job_id}/download/{bundle.name}",
            "filename": f"{base}-ocr-{ts}.zip",
            "preview": preview,
            "notice": notice,
        }
    # default: pdf
    return {
        "download": f"/api/jobs/{job_id}/download/{out_pdf.name}",
        "filename": f"{base}-ocr-{ts}.pdf",
        "preview": preview,
        "notice": notice,
    }


_SKIP_RE = re.compile(r"\[OCR skipped on page\(s\)\s*([^\]]+)\]")


def _augment_sidecar_with_extracted_text(pdf_path: Path, sidecar: Path) -> tuple[Optional[str], str]:
    """If the sidecar has '[OCR skipped on page(s) ...]' markers, replace them
    with the extracted text from those pages of `pdf_path` (the OCR output PDF,
    which keeps the original text layer for skipped pages).

    Returns (skipped_pages_human, full_sidecar_text).
    skipped_pages_human is None when no skips happened, "all" when every page
    skipped, or a human string like "pages 1-12" otherwise.
    """
    if not sidecar.exists() or not pdf_path.exists():
        return None, ""

    text = sidecar.read_text(errors="replace")
    matches = list(_SKIP_RE.finditer(text))
    if not matches:
        return None, text

    skipped_ranges: list[str] = [m.group(1).strip() for m in matches]
    pages_skipped: set[int] = set()
    for spec in skipped_ranges:
        for grp in spec.split(","):
            grp = grp.strip()
            if not grp:
                continue
            try:
                if "-" in grp:
                    a, b = grp.split("-", 1)
                    for i in range(int(a), int(b) + 1):
                        pages_skipped.add(i)
                else:
                    pages_skipped.add(int(grp))
            except ValueError:
                pass

    # Extract real text from the PDF for those pages
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:  # noqa: BLE001
        log.warning("could not open pdf for text extraction: %s", e)
        return ", ".join(skipped_ranges), text

    try:
        total_pages = doc.page_count
        per_page: dict[int, str] = {}
        for p in pages_skipped:
            if 1 <= p <= total_pages:
                per_page[p] = doc.load_page(p - 1).get_text("text")
    finally:
        doc.close()

    # Replace each marker in-place with that range's extracted text
    def _replace(m: re.Match) -> str:
        spec = m.group(1).strip()
        chunks: list[str] = []
        for grp in spec.split(","):
            grp = grp.strip()
            if "-" in grp:
                a, b = grp.split("-", 1)
                rng = range(int(a), int(b) + 1)
            else:
                rng = range(int(grp), int(grp) + 1)
            for p in rng:
                if p in per_page:
                    chunks.append(per_page[p].rstrip() + "\n")
        return "".join(chunks).rstrip() + "\n"

    new_text = _SKIP_RE.sub(_replace, text)
    sidecar.write_text(new_text)

    skipped_human = (
        "all" if total_pages and len(pages_skipped) >= total_pages
        else f"pages {', '.join(skipped_ranges)}"
    )
    return skipped_human, new_text


@app.get("/api/jobs/{job_id}/text-preview")
async def text_preview(job_id: str):
    jdir = _safe_job_dir(job_id)
    # Pick the most-recently-written ocr-<ts>.txt sidecar in this job.
    candidates = sorted(jdir.glob("ocr-*.txt"))
    if not candidates:
        raise HTTPException(404, "no OCR text yet")
    return {"text": candidates[-1].read_text(errors="replace")}


@app.get("/api/jobs/{job_id}/download/{name}")
async def download(job_id: str, name: str):
    jdir = _safe_job_dir(job_id)
    if "/" in name or ".." in name:
        raise HTTPException(400, "bad name")
    f = jdir / name
    if not f.exists() or not f.is_file():
        raise HTTPException(404, "file not found")
    media = "application/pdf"
    if name.endswith(".zip"):
        media = "application/zip"
    elif name.endswith(".txt"):
        media = "text/plain; charset=utf-8"
    return FileResponse(f, media_type=media, filename=name)


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    jdir = _safe_job_dir(job_id)
    shutil.rmtree(jdir, ignore_errors=True)
    return {"ok": True}


# ---------- static (built frontend) ----------

if STATIC_DIR.exists():
    # Serve assets folder; fall through to index.html for SPA routes.
    assets = STATIC_DIR / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str, request: Request):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        target = STATIC_DIR / full_path
        if full_path and target.is_file():
            return FileResponse(target)
        index = STATIC_DIR / "index.html"
        if index.exists():
            return FileResponse(index)
        raise HTTPException(404)
