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
JANITOR_INTERVAL_SEC = int(os.environ.get("PDFFLIX_JANITOR_INTERVAL", "60"))
# Hard ceiling on total JOBS_DIR size. When exceeded, oldest jobs are
# evicted until we're back under the cap. Defaults to 2 GiB.
JOBS_DIR_CAP_BYTES = int(os.environ.get("PDFFLIX_JOBS_CAP_MB", "2048")) * 1024 * 1024

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


def _evict_glob(jdir: Path, pattern: str, keep: Path | None = None) -> int:
    """Delete files in `jdir` matching `pattern`, optionally keeping `keep`.
    Used to clean up per-operation intermediates (compress attempts, OCR
    pre-clean copies, merge inputs) without touching cached thumbnails or
    final outputs. Returns count deleted."""
    n = 0
    for f in jdir.glob(pattern):
        if not f.is_file():
            continue
        if keep is not None and f.resolve() == keep.resolve():
            continue
        try:
            f.unlink()
            n += 1
        except OSError as e:
            log.warning("evict %s: %s", f, e)
    return n


def _dir_bytes(p: Path) -> int:
    """Recursive byte size of a directory."""
    total = 0
    try:
        for entry in p.iterdir():
            try:
                if entry.is_dir():
                    total += _dir_bytes(entry)
                else:
                    total += entry.stat().st_size
            except OSError:
                pass
    except OSError:
        pass
    return total


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
        """Two-phase sweep:
        1. TTL sweep — evict jobs that haven't been touched in JOB_TTL_SEC.
        2. Size sweep — if JOBS_DIR is still over JOBS_DIR_CAP_BYTES, evict
           oldest jobs (by mtime) until back under the cap. This protects the
           Pi's SD card from filling up if someone uploads a lot in quick
           succession (TTL alone wouldn't help)."""
        while not stop.is_set():
            try:
                # Phase 1: TTL eviction
                cutoff = time.time() - JOB_TTL_SEC
                ttl_evicted = 0
                jobs: list[tuple[Path, float, int]] = []
                for d in JOBS_DIR.iterdir():
                    if not d.is_dir():
                        continue
                    try:
                        mtime = d.stat().st_mtime
                    except OSError:
                        continue
                    if mtime < cutoff:
                        shutil.rmtree(d, ignore_errors=True)
                        ttl_evicted += 1
                        continue
                    jobs.append((d, mtime, _dir_bytes(d)))

                # Phase 2: size-cap eviction (oldest first)
                total = sum(sz for _, _, sz in jobs)
                size_evicted = 0
                if total > JOBS_DIR_CAP_BYTES:
                    jobs.sort(key=lambda x: x[1])  # oldest first
                    for d, _, sz in jobs:
                        if total <= JOBS_DIR_CAP_BYTES:
                            break
                        shutil.rmtree(d, ignore_errors=True)
                        total -= sz
                        size_evicted += 1

                if ttl_evicted or size_evicted:
                    log.info(
                        "janitor: ttl_evicted=%d size_evicted=%d remaining=%d total=%dMB cap=%dMB",
                        ttl_evicted, size_evicted, len(jobs) - size_evicted,
                        total // 1024 // 1024, JOBS_DIR_CAP_BYTES // 1024 // 1024,
                    )
            except Exception as e:  # noqa: BLE001
                log.warning("janitor error: %s", e)
            try:
                await asyncio.wait_for(stop.wait(), timeout=JANITOR_INTERVAL_SEC)
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


@app.get("/api/status")
async def status():
    """Operational view: per-job sizes, total JOBS_DIR bytes used, free disk on
    the volume, and the current cleanup settings. Useful for verifying that
    intermediate cleanup works and that the size cap is doing its job."""
    jobs = []
    total = 0
    now = time.time()
    if JOBS_DIR.exists():
        for d in sorted(JOBS_DIR.iterdir()):
            if not d.is_dir():
                continue
            try:
                sz = _dir_bytes(d)
                mtime = d.stat().st_mtime
            except OSError:
                continue
            total += sz
            jobs.append({
                "id": d.name,
                "bytes": sz,
                "files": sum(1 for _ in d.iterdir() if _.is_file()),
                "age_sec": int(now - mtime),
                "ttl_remaining_sec": max(0, JOB_TTL_SEC - int(now - mtime)),
            })
    try:
        st = shutil.disk_usage(JOBS_DIR)
        disk_free = st.free
        disk_total = st.total
    except Exception:  # noqa: BLE001
        disk_free = disk_total = -1
    return {
        "jobs_dir": str(JOBS_DIR),
        "job_count": len(jobs),
        "jobs_total_bytes": total,
        "jobs_cap_bytes": JOBS_DIR_CAP_BYTES,
        "job_ttl_sec": JOB_TTL_SEC,
        "janitor_interval_sec": JANITOR_INTERVAL_SEC,
        "disk_free_bytes": disk_free,
        "disk_total_bytes": disk_total,
        "jobs": jobs,
    }


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


def _chunk_meta(chunk_files: list[Path], page_groups: list[list[int]]) -> list[dict]:
    return [
        {
            "index": i + 1,
            "pages": _fmt_pages(page_groups[i]),
            "page_count": len(page_groups[i]),
            "size": p.stat().st_size,
        }
        for i, p in enumerate(chunk_files)
    ]


def _fmt_pages(pages_1idx: list[int]) -> str:
    """Collapse a sorted list of 1-indexed page numbers into a ranges string."""
    if not pages_1idx:
        return ""
    out, s, p = [], pages_1idx[0], pages_1idx[0]
    for x in pages_1idx[1:]:
        if x == p + 1:
            p = x
        else:
            out.append(f"{s}" if s == p else f"{s}-{p}")
            s = p = x
    out.append(f"{s}" if s == p else f"{s}-{p}")
    return ",".join(out)


def _zip_chunks(out_files: list[Path], bundle: Path, base: str) -> Path:
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, f in enumerate(out_files, 1):
            zf.write(f, arcname=f"{base}-part-{i:03d}.pdf")
    return bundle


@app.post("/api/jobs/{job_id}/split")
async def split(
    job_id: str,
    mode: str = Form("zip"),
    ranges: str = Form(""),
    pages_per_chunk: int = Form(0),
    size_per_chunk_mb: float = Form(0.0),
):
    """Split.

    mode = "zip"       → one PDF per range, bundled in a zip (or single PDF if one range)
    mode = "combined"  → flatten all ranges into one PDF (used by "Pick pages")
    mode = "every-n"   → chunk into PDFs of pages_per_chunk pages each
    mode = "by-size"   → chunk into PDFs each ≤ size_per_chunk_mb (binary-search per chunk)
    """
    jdir = _safe_job_dir(job_id)
    src = jdir / "input.pdf"
    meta = json.loads((jdir / "meta.json").read_text())
    base = Path(meta["filename"]).stem
    ts = _ts()
    total_pages = int(meta["pages"])

    # ---------- every-n: N pages per chunk ----------
    if mode == "every-n":
        if pages_per_chunk < 1:
            raise HTTPException(400, "pages_per_chunk must be at least 1")
        page_groups: list[list[int]] = []
        cursor = 1
        while cursor <= total_pages:
            end = min(cursor + pages_per_chunk - 1, total_pages)
            page_groups.append(list(range(cursor, end + 1)))
            cursor = end + 1
        out_files: list[Path] = []
        with pikepdf.open(src) as pdf:
            for idx, pages in enumerate(page_groups, 1):
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
                "chunks": _chunk_meta(out_files, page_groups),
            }
        bundle = jdir / f"split-bypages-{pages_per_chunk}-{ts}.zip"
        _zip_chunks(out_files, bundle, base)
        return {
            "download": f"/api/jobs/{job_id}/download/{bundle.name}",
            "filename": f"{base}-split-{pages_per_chunk}p-{ts}.zip",
            "chunks": _chunk_meta(out_files, page_groups),
        }

    # ---------- by-size: each chunk ≤ N MB ----------
    if mode == "by-size":
        if size_per_chunk_mb <= 0:
            raise HTTPException(400, "size_per_chunk_mb must be > 0")
        target_bytes = int(size_per_chunk_mb * 1024 * 1024)
        out_files = []
        page_groups = []
        overflows: list[int] = []
        trial = jdir / f"trial-{ts}.pdf"
        with pikepdf.open(src) as pdf:
            cursor = 0  # 0-indexed
            chunk_idx = 1
            while cursor < total_pages:
                # Binary search: largest k ≥ 1 such that pages [cursor..cursor+k-1]
                # saved as a PDF is ≤ target_bytes.
                lo, hi = 1, total_pages - cursor
                best_k = 1
                fit_found = False
                while lo <= hi:
                    k = (lo + hi) // 2
                    with pikepdf.new() as new_pdf:
                        for p in range(cursor, cursor + k):
                            new_pdf.pages.append(pdf.pages[p])
                        new_pdf.save(trial)
                    sz = trial.stat().st_size
                    if sz <= target_bytes:
                        best_k = k
                        fit_found = True
                        lo = k + 1
                    else:
                        hi = k - 1
                # Build final chunk
                out = jdir / f"part-{ts}-{chunk_idx:03d}.pdf"
                with pikepdf.new() as new_pdf:
                    for p in range(cursor, cursor + best_k):
                        new_pdf.pages.append(pdf.pages[p])
                    new_pdf.save(out)
                if not fit_found:
                    overflows.append(chunk_idx)
                out_files.append(out)
                page_groups.append(list(range(cursor + 1, cursor + best_k + 1)))
                cursor += best_k
                chunk_idx += 1
        trial.unlink(missing_ok=True)

        notice: Optional[str] = None
        if overflows:
            biggest = max(out_files[i - 1].stat().st_size for i in overflows)
            notice = (
                f"{len(overflows)} chunk(s) couldn't fit ≤ {size_per_chunk_mb} MB "
                f"because a single page is bigger than the target "
                f"(largest: {biggest / 1024 / 1024:.2f} MB). Consider compressing "
                f"the PDF first."
            )

        if len(out_files) == 1:
            return {
                "download": f"/api/jobs/{job_id}/download/{out_files[0].name}",
                "filename": f"{base}-pages-{ts}.pdf",
                "chunks": _chunk_meta(out_files, page_groups),
                "notice": notice,
            }
        bundle = jdir / f"split-bysize-{int(size_per_chunk_mb*10)}dMB-{ts}.zip"
        _zip_chunks(out_files, bundle, base)
        return {
            "download": f"/api/jobs/{job_id}/download/{bundle.name}",
            "filename": f"{base}-split-{int(size_per_chunk_mb*10)}dMB-{ts}.zip"
                        .replace("dMB", "dMB"),
            "chunks": _chunk_meta(out_files, page_groups),
            "notice": notice,
        }

    # ---------- existing zip / combined modes need ranges ----------
    if not ranges.strip():
        raise HTTPException(400, "ranges required for this mode")
    groups = _parse_ranges(ranges, total_pages)

    if mode == "combined":
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
    out_files = []
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
    _zip_chunks(out_files, bundle, base)
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
    # Drop the per-file input copies — the merged PDF supersedes them and
    # they can collectively be much larger than the output.
    for p in saved:
        p.unlink(missing_ok=True)
    return {
        "job_id": jid,
        "download": f"/api/jobs/{jid}/download/{out.name}",
        "filename": out.name,
    }


# --- Compression specs -------------------------------------------------------
# Each spec is a dict the helper translates into Ghostscript flags. A spec with
# gs="/screen" only uses the preset defaults; one with explicit dpi/qf forces
# image downsampling and JPEG re-encoding at the given quality factor.
_LEVELS: dict[str, dict] = {
    "strong":  {"gs": "/screen",   "dpi": None, "qf": None, "label": "Strong",
                "sub": "~72 dpi · smallest file"},
    "medium":  {"gs": "/ebook",    "dpi": None, "qf": None, "label": "Medium",
                "sub": "~150 dpi · balanced"},
    "light":   {"gs": "/printer",  "dpi": None, "qf": None, "label": "Light",
                "sub": "~300 dpi · print quality"},
    "minimal": {"gs": "/prepress", "dpi": None, "qf": None, "label": "Minimal",
                "sub": "~300 dpi · near-original"},
    "extreme": {"gs": "/screen",   "dpi": 72,   "qf": 2.4,  "label": "Extreme",
                "sub": "72 dpi, forced JPEG re-encode"},
}

# Ladder used by target-size mode. Highest quality first; stop at first
# attempt that fits the requested size.
_TARGET_LADDER: list[dict] = [
    {"gs": "/ebook",   "dpi": None, "qf": None, "label": "Medium (150 dpi)"},
    {"gs": "/screen",  "dpi": None, "qf": None, "label": "Strong (72 dpi)"},
    {"gs": "/screen",  "dpi": 72,   "qf": 2.0,  "label": "Extreme 72 dpi"},
    {"gs": "/screen",  "dpi": 60,   "qf": 2.4,  "label": "Extreme 60 dpi"},
    {"gs": "/screen",  "dpi": 50,   "qf": 2.4,  "label": "Extreme 50 dpi"},
    {"gs": "/screen",  "dpi": 40,   "qf": 2.5,  "label": "Extreme 40 dpi"},
    {"gs": "/screen",  "dpi": 30,   "qf": 2.5,  "label": "Extreme 30 dpi"},
    {"gs": "/screen",  "dpi": 24,   "qf": 3.0,  "label": "Extreme 24 dpi (last resort)"},
]


async def _run_gs_compress(src: Path, out: Path, spec: dict) -> None:
    """Run ghostscript pdfwrite with knobs from `spec`."""
    cmd = [
        "gs", "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        f"-dPDFSETTINGS={spec['gs']}",
        "-dNOPAUSE", "-dQUIET", "-dBATCH",
        "-dDetectDuplicateImages=true",
        "-dCompressFonts=true",
    ]
    if spec.get("dpi") is not None:
        dpi = int(spec["dpi"])
        cmd += [
            "-dDownsampleColorImages=true",
            "-dColorImageDownsampleType=/Average",
            f"-dColorImageResolution={dpi}",
            "-dColorImageDownsampleThreshold=1.0",
            "-dDownsampleGrayImages=true",
            "-dGrayImageDownsampleType=/Average",
            f"-dGrayImageResolution={dpi}",
            "-dGrayImageDownsampleThreshold=1.0",
            "-dDownsampleMonoImages=true",
            "-dMonoImageDownsampleType=/Subsample",
            f"-dMonoImageResolution={max(dpi * 2, 150)}",
            "-dMonoImageDownsampleThreshold=1.0",
        ]
    # We skip explicit JPEG QFactor dicts here — passing nested PostScript dicts
    # through the gs command line is fragile (parse errors), and /screen / /ebook
    # already use DCTEncode, so DPI downsampling alone is the dominant lever.
    if spec.get("qf") is not None:
        cmd += [
            "-dAutoFilterColorImages=false",
            "-dAutoFilterGrayImages=false",
            "-dColorImageFilter=/DCTEncode",
            "-dGrayImageFilter=/DCTEncode",
        ]
    cmd += [f"-sOutputFile={out}", str(src)]
    log.info("gs: %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await proc.communicate()
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(stderr.decode("utf-8", "replace")[-400:])


@app.post("/api/jobs/{job_id}/compress")
async def compress(
    job_id: str,
    level: str = Form("medium"),
    target_mb: float = Form(0.0),
):
    """Reduce PDF size.

    If `target_mb > 0`: iterate through the ladder, return the first attempt
    whose output is ≤ target_mb. The `level` arg is ignored in this mode.

    Otherwise: single-shot at the requested level
    (strong | medium | light | minimal | extreme).
    """
    jdir = _safe_job_dir(job_id)
    src = jdir / "input.pdf"
    if not src.exists():
        raise HTTPException(404, "input missing")
    meta = json.loads((jdir / "meta.json").read_text())
    base = Path(meta["filename"]).stem
    ts = _ts()
    original_size = src.stat().st_size

    # ---- target-size mode ----
    if target_mb and target_mb > 0:
        target_bytes = int(target_mb * 1024 * 1024)
        if target_bytes >= original_size:
            raise HTTPException(
                400,
                f"target {target_mb} MB ≥ original ({original_size / 1024 / 1024:.2f} MB). "
                f"Pick a smaller target or use a preset level.",
            )
        attempts: list[dict] = []
        best: tuple[Path, int, dict] | None = None
        for i, spec in enumerate(_TARGET_LADDER, 1):
            tmp = jdir / f"compressed-target-attempt{i}-{ts}.pdf"
            try:
                await _run_gs_compress(src, tmp, spec)
            except RuntimeError as e:
                attempts.append({"label": spec["label"], "size": None, "error": str(e)})
                continue
            sz = tmp.stat().st_size
            fits = sz <= target_bytes
            attempts.append({"label": spec["label"], "size": sz, "fits": fits})
            if best is None or sz < best[1]:
                best = (tmp, sz, spec)
            if fits:
                final = jdir / f"compressed-target-{int(target_mb*10)}dMB-{ts}.pdf"
                tmp.replace(final)
                # Delete every other attempt file from this run — they're no
                # longer useful and would otherwise occupy multiples of the
                # final output's size on disk.
                _evict_glob(jdir, f"compressed-target-attempt*-{ts}.pdf", keep=None)
                saved = max(0, original_size - sz)
                return {
                    "download": f"/api/jobs/{job_id}/download/{final.name}",
                    "filename": f"{base}-compressed-{int(target_mb*10)}dMB-{ts}.pdf"
                                .replace("dMB", "dMB"),
                    "level": "target",
                    "level_label": f"Target {target_mb} MB — {spec['label']}",
                    "original_size": original_size,
                    "new_size": sz,
                    "saved_bytes": saved,
                    "ratio_percent": round((saved / original_size) * 100, 1),
                    "target_bytes": target_bytes,
                    "attempts": attempts,
                    "notice": None,
                }
        # Nothing fit — return smallest we produced.
        if best is None:
            raise HTTPException(500, "compression failed on every attempt")
        out, sz, spec = best
        final = jdir / f"compressed-target-best-{ts}.pdf"
        out.replace(final)
        # Delete all the non-winning attempt files from this run.
        _evict_glob(jdir, f"compressed-target-attempt*-{ts}.pdf", keep=None)
        saved = max(0, original_size - sz)
        return {
            "download": f"/api/jobs/{job_id}/download/{final.name}",
            "filename": f"{base}-compressed-best-{ts}.pdf",
            "level": "target",
            "level_label": f"Target {target_mb} MB — best effort: {spec['label']}",
            "original_size": original_size,
            "new_size": sz,
            "saved_bytes": saved,
            "ratio_percent": round((saved / original_size) * 100, 1) if original_size else 0,
            "target_bytes": target_bytes,
            "attempts": attempts,
            "notice": (
                f"Couldn't hit {target_mb} MB even at the most aggressive setting "
                f"({spec['label']}). This PDF is mostly text or vectors that don't "
                f"shrink with image compression. Returning the smallest attempt "
                f"({sz / 1024 / 1024:.2f} MB)."
            ),
        }

    # ---- single-level mode ----
    if level not in _LEVELS:
        raise HTTPException(400, f"invalid level (got {level!r})")
    spec = _LEVELS[level]
    out = jdir / f"compressed-{level}-{ts}.pdf"
    try:
        await _run_gs_compress(src, out, spec)
    except RuntimeError as e:
        raise HTTPException(500, f"compress failed: {e}")
    new_size = out.stat().st_size
    saved = max(0, original_size - new_size)
    ratio = round((saved / original_size) * 100, 1) if original_size else 0.0
    notice: Optional[str] = None
    if new_size >= original_size:
        notice = (
            "The compressed file is the same size or larger than the original — "
            "this PDF is already heavily compressed, or contains mostly vector / "
            "text content that can't shrink further. Try Extreme, or set a "
            "target size to iterate further."
        )
    return {
        "download": f"/api/jobs/{job_id}/download/{out.name}",
        "filename": f"{base}-compressed-{level}-{ts}.pdf",
        "level": level,
        "level_label": spec["label"],
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
    force: bool = Form(True),  # default True — always re-recognize, never preserve a
                               # possibly-junk existing text layer. Kept as a Form arg
                               # so callers can opt out via force=false if they really
                               # want the old --skip-text behavior.
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

    # 1) Pre-clean the input with pikepdf. A lot of "INVALID PDF" failures from
    #    ocrmypdf trace back to a malformed source — re-saving through pikepdf
    #    rewrites the xref and object streams, fixing most issues.
    cleaned = jdir / f"cleaned-{ts}.pdf"
    use_src = src
    try:
        with pikepdf.open(src) as p:
            p.save(cleaned)
        use_src = cleaned
        log.info("ocr: pre-cleaned via pikepdf -> %s", cleaned.name)
    except Exception as e:  # noqa: BLE001
        log.warning("ocr: pikepdf pre-clean failed (%s), using original", e)

    # 2) Retry ladder.
    #
    #    Many "INVALID PDF" failures are caused by a *broken* existing text
    #    layer — e.g. a previous bad OCR pass with garbled ToUnicode tables.
    #    When the user picked the default (skip-text), ocrmypdf tries to keep
    #    that broken layer and then fails its own QA. The right fix is to
    #    quietly fall back to re-recognizing every page from scratch
    #    (--force-ocr), which sidesteps the broken layer entirely. The user
    #    asked for "Run OCR" — they don't need to know we tried two strategies.
    #
    #    Order:
    #      1. requested mode + default optimization
    #      2. requested mode + safer optimization (--optimize 0 --clean)
    #      3. force-ocr (only if user didn't already pick it) — last rescue
    #         before the no-OCR fallback. Same result as the user enabling
    #         "Force OCR" themselves.
    base_cmd = [
        "ocrmypdf",
        "-l", language,
        "--sidecar", str(sidecar),
        "--output-type", "pdf",
        "--jobs", str(max(1, os.cpu_count() or 2)),
    ]
    requested_flag = "--force-ocr" if force else "--skip-text"

    attempts: list[tuple[str, list[str]]] = [
        ("default",        ["--optimize", "1", requested_flag]),
        ("safer",          ["--optimize", "0", "--clean", requested_flag]),
    ]
    if not force:
        attempts.append(("auto-force-ocr", ["--optimize", "0", "--clean", "--force-ocr"]))

    last_err = ""
    ocr_succeeded = False
    used_attempt = ""
    for label, extra in attempts:
        cmd = base_cmd + extra + [str(use_src), str(out_pdf)]
        log.info("ocr cmd [%s]: %s", label, " ".join(cmd))
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await proc.communicate()
        last_err = stderr.decode("utf-8", "replace")
        if proc.returncode == 0 and out_pdf.exists() and out_pdf.stat().st_size > 0:
            ocr_succeeded = True
            used_attempt = label
            log.info("ocr: succeeded via %s", label)
            break
        log.warning("ocr attempt '%s' failed (rc=%s): %s", label, proc.returncode, last_err[-600:])
        out_pdf.unlink(missing_ok=True)

    ocr_fallback_notice: Optional[str] = None

    if not ocr_succeeded:
        # 3) Last-resort fallback: extract whatever text the input already has
        #    via PyMuPDF, write it as the sidecar, and (if user wanted a PDF)
        #    serve the cleaned input as-is. The user at least gets *something*.
        log.warning("ocr: all attempts failed, falling back to text extraction")
        text_parts: list[str] = []
        try:
            doc = fitz.open(use_src)
            try:
                for i in range(doc.page_count):
                    text_parts.append(doc.load_page(i).get_text("text"))
            finally:
                doc.close()
        except Exception as e:  # noqa: BLE001
            log.error("ocr fallback text extraction failed: %s", e)
            raise HTTPException(
                500,
                "Couldn't run OCR on this PDF and couldn't read it for text "
                "extraction either. The file may be corrupted or "
                "password-protected. Try compressing it first to normalize "
                "the format."
            )
        sidecar.write_text("\n".join(text_parts))
        if output != "text":
            shutil.copyfile(use_src, out_pdf)
        ocr_fallback_notice = (
            "Couldn't run OCR on this PDF. Try compressing it first to "
            "normalize the format, then run OCR again."
        )

    # The pre-cleaned input copy is intermediate — only useful for the OCR run
    # that just happened. Remove it now so multiple OCR runs in the same job
    # don't pile up Nx the input size on disk.
    if cleaned.exists() and cleaned != out_pdf:
        cleaned.unlink(missing_ok=True)

    # If ocrmypdf skipped pages because they already have a text layer,
    # the sidecar is a placeholder like "[OCR skipped on page(s) 1-12]".
    # In that case (or any partial-skip), splice in the existing text layer
    # so a .txt download is always actually useful.
    skipped_pages, sidecar_text = _augment_sidecar_with_extracted_text(out_pdf, sidecar)
    notice: Optional[str] = None
    if ocr_fallback_notice:
        notice = ocr_fallback_notice
    elif skipped_pages:
        # Only reachable when an API caller passes force=false explicitly — the
        # UI always sends force=true now. Keep the message factual.
        if skipped_pages == "all":
            notice = (
                "This PDF already had selectable text on every page, so the existing "
                "text was kept instead of re-recognizing."
            )
        else:
            notice = (
                f"Kept existing text for {skipped_pages}. The remaining pages were OCR'd."
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
