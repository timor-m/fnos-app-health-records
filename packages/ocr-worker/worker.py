#!/usr/bin/env python3
"""Single-process health report OCR worker using NDJSON over stdin/stdout.

PDF rendering is intentionally kept in this worker so the Nitro process stays
free of native image/PDF dependencies.
"""

from __future__ import annotations

import argparse
import gc
import json
import io
import math
import os
import platform
import re
import sys
import time
import traceback
import tempfile
import threading
import unicodedata
from contextlib import suppress
from pathlib import Path
from typing import Any

ENGINE_NAME = "rapidocr"
MODEL_VERSION = "PP-OCRv4-mobile"
CURRENT_ENGINE_NAME = "rapidocr-uninitialized"
CURRENT_ENGINE_VERSION = "unknown"
_EMIT_LOCK = threading.Lock()

def emit(payload: dict[str, Any]) -> None:
    # Heartbeats are emitted from a helper thread while the main thread is inside
    # native OCR/PDF work. Serialize writes so every NDJSON envelope stays atomic.
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _EMIT_LOCK:
        print(encoded, flush=True)


class WorkerInputError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ResourceBoundaryError(WorkerInputError):
    pass


class InputDecodeError(WorkerInputError):
    pass


SUPPORTED_MIME_TYPES = {
    "application/pdf": "pdf",
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heic",
}


def detect_input_format(input_path: Path) -> str | None:
    try:
        with input_path.open("rb") as source:
            header = source.read(32)
    except Exception as error:
        raise ResourceBoundaryError("INPUT_FILE_INVALID", "Input file cannot be read") from error
    if header.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "webp"
    if header.startswith(b"%PDF-"):
        return "pdf"
    if len(header) >= 12 and header[4:8] == b"ftyp" and header[8:12] in {
        b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"
    }:
        return "heic"
    return None


def expected_format_for_path(input_path: Path) -> str | None:
    return {
        ".pdf": "pdf",
        ".jpg": "jpeg",
        ".jpeg": "jpeg",
        ".png": "png",
        ".webp": "webp",
        ".heic": "heic",
        ".heif": "heic",
    }.get(input_path.suffix.lower())


def validate_input_format(
    input_path: Path,
    action: str,
    expected_mime_type: str | None = None,
) -> str:
    detected = detect_input_format(input_path)
    expected = SUPPORTED_MIME_TYPES.get(str(expected_mime_type or "").lower())
    path_expected = expected_format_for_path(input_path)
    if action == "inspect_pdf":
        expected = "pdf"
    if detected is None or (expected and detected != expected) or (path_expected and detected != path_expected):
        raise InputDecodeError("INPUT_FORMAT_MISMATCH", "Input file format does not match its declared type")
    return detected


def open_pdf_document(input_path: Path) -> Any:
    import fitz

    try:
        return fitz.open(input_path)
    except Exception as error:
        raise InputDecodeError("PDF_DECODE_FAILED", "PDF file cannot be decoded") from error


def open_image_source(input_path: Path) -> Any:
    try:
        if input_path.suffix.lower() in {".heic", ".heif"}:
            from pillow_heif import register_heif_opener

            register_heif_opener()
        from PIL import Image

        Image.MAX_IMAGE_PIXELS = max_image_pixels()
        return Image.open(input_path)
    except ResourceBoundaryError:
        raise
    except Exception as error:
        raise InputDecodeError("IMAGE_DECODE_FAILED", "Image file cannot be decoded") from error


def pdf_operation(operation: Any, message: str = "PDF content cannot be decoded") -> Any:
    try:
        return operation()
    except ResourceBoundaryError:
        raise
    except InputDecodeError:
        raise
    except Exception as error:
        raise InputDecodeError("PDF_DECODE_FAILED", message) from error


def cleanup_partial_output(output_path: Path | None) -> None:
    if output_path is None:
        return
    with suppress(Exception):
        if output_path.is_file():
            output_path.unlink()


def bounded_resource_limit(name: str, fallback: int, minimum: int, maximum: int) -> int:
    try:
        value = int(float(os.environ.get(name, str(fallback)) or fallback))
    except Exception:
        value = fallback
    return max(minimum, min(maximum, value))


def max_input_file_bytes() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_INPUT_FILE_BYTES", 40 * 1024 * 1024, 1, 1024 * 1024 * 1024
    )


def max_pdf_pages() -> int:
    return bounded_resource_limit("OCR_WORKER_MAX_PDF_PAGES", 500, 1, 10000)


def max_image_pixels() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_IMAGE_PIXELS", 40000000, 1000000, 500000000
    )


# OpenCV reads this boundary when the module is imported. Keep it aligned with
# the explicit application-level dimension check below, and normalize invalid
# environment values before native code sees them.
os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = str(max_image_pixels())


def max_pdf_page_render_pixels() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_PDF_PAGE_RENDER_PIXELS", 80000000, 1000000, 500000000
    )


def max_worker_rss_bytes() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_RSS_BYTES",
        1536 * 1024 * 1024,
        1,
        16 * 1024 * 1024 * 1024,
    )


def max_ocr_requests_per_process() -> int:
    return bounded_resource_limit(
        "OCR_WORKER_MAX_OCR_REQUESTS_PER_PROCESS", 32, 1, 10000
    )


def worker_heartbeat_interval_seconds() -> float:
    milliseconds = bounded_resource_limit(
        "OCR_WORKER_HEARTBEAT_INTERVAL_MS", 15000, 100, 60000
    )
    return milliseconds / 1000


def is_arm_machine() -> bool:
    return platform.machine().strip().lower() in {"aarch64", "arm64", "armv7l", "armv6l"}


def onnx_intra_op_num_threads() -> int:
    # 0 keeps the onnxruntime default of using every core. Small ARM NAS boards
    # share a few little cores with the whole system, so leave one core for the
    # OS unless the operator overrides the limit explicitly.
    fallback = 0
    if is_arm_machine():
        fallback = max(1, min(4, (os.cpu_count() or 2) - 1))
    return bounded_resource_limit("OCR_WORKER_ONNX_INTRA_OP_THREADS", fallback, 0, 64)


def onnx_inter_op_num_threads() -> int:
    fallback = 1 if is_arm_machine() else 0
    return bounded_resource_limit("OCR_WORKER_ONNX_INTER_OP_THREADS", fallback, 0, 64)


def onnx_engine_kwargs() -> dict[str, int]:
    intra = onnx_intra_op_num_threads()
    if intra <= 0:
        return {}
    return {
        "intra_op_num_threads": intra,
        "inter_op_num_threads": max(1, onnx_inter_op_num_threads()),
    }


class RequestHeartbeat:
    def __init__(self, request_id: Any, action: str, started: float):
        self.request_id = request_id
        self.action = action
        self.started = started
        self.stopped = threading.Event()
        self.thread = threading.Thread(
            target=self._run,
            name="ocr-worker-heartbeat",
            daemon=True,
        )

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stopped.set()
        self.thread.join(timeout=1.0)

    def _run(self) -> None:
        interval = worker_heartbeat_interval_seconds()
        while not self.stopped.wait(interval):
            emit(
                {
                    "type": "heartbeat",
                    "id": self.request_id,
                    "action": self.action,
                    "elapsedMs": round((time.perf_counter() - self.started) * 1000),
                }
            )


def process_rss_bytes() -> int:
    """Return current RSS where available, otherwise the process peak RSS."""
    try:
        statm = Path("/proc/self/statm").read_text(encoding="ascii").split()
        if len(statm) >= 2:
            return max(0, int(statm[1]) * int(os.sysconf("SC_PAGE_SIZE")))
    except Exception:
        pass
    return process_peak_rss_bytes()


def process_peak_rss_bytes() -> int:
    try:
        import resource

        maximum_rss = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        # macOS reports bytes; Linux and the common NAS Python runtimes report KiB.
        return max(0, maximum_rss if sys.platform == "darwin" else maximum_rss * 1024)
    except Exception:
        return 0


def release_request_resources() -> None:
    # Pillow, PyMuPDF, OpenCV and OCR backends may leave Python-side reference
    # cycles around native buffers. Collection here releases everything that is
    # no longer needed before deciding whether the process crossed its high-water
    # mark. Native allocator arenas are reclaimed by the planned process recycle.
    with suppress(Exception):
        gc.collect()


def worker_recycle_reason(
    action: str,
    recycle_after_response: bool,
    ocr_request_count: int,
    rss_bytes: int,
) -> str | None:
    if recycle_after_response and action == "ocr":
        return "report_boundary"
    if rss_bytes >= max_worker_rss_bytes():
        return "memory_high_water"
    if action == "ocr" and ocr_request_count >= max_ocr_requests_per_process():
        return "request_limit"
    return None


def validate_input_file(input_path: Path) -> None:
    try:
        size = input_path.stat().st_size
    except Exception as error:
        raise ResourceBoundaryError("INPUT_FILE_INVALID", f"Input file cannot be read: {input_path}") from error
    if not input_path.is_file():
        raise ResourceBoundaryError("INPUT_FILE_INVALID", f"Input path is not a regular file: {input_path}")
    if size < 1:
        raise ResourceBoundaryError("INPUT_FILE_EMPTY", f"Input file is empty: {input_path}")
    if size > max_input_file_bytes():
        raise ResourceBoundaryError("INPUT_FILE_TOO_LARGE", "Input file exceeds the worker safety limit")


def validate_image_dimensions(input_path: Path) -> tuple[int, int]:
    try:
        with open_image_source(input_path) as source:
            width, height = source.size
            if width < 1 or height < 1 or width * height > max_image_pixels():
                raise ResourceBoundaryError(
                    "IMAGE_DIMENSIONS_EXCEEDED",
                    f"Image dimensions exceed the worker safety limit: {width}x{height}",
                )
            # Pillow is lazy. Force the pixel stream to be decoded before the OCR
            # engine is loaded so truncated/corrupt images fail deterministically.
            source.load()
    except ResourceBoundaryError:
        raise
    except InputDecodeError:
        raise
    except Exception as error:
        raise InputDecodeError("IMAGE_DECODE_FAILED", "Image file cannot be decoded") from error
    return int(width), int(height)


def validate_pdf_document(document: Any) -> int:
    page_count = int(document.page_count)
    if page_count < 1:
        raise ResourceBoundaryError("PDF_PAGE_COUNT_INVALID", "PDF does not contain any pages")
    if page_count > max_pdf_pages():
        raise ResourceBoundaryError(
            "PDF_PAGE_COUNT_EXCEEDED",
            f"PDF page count exceeds the worker safety limit: {page_count}",
        )
    return page_count


def validate_pdf_page(page: Any, render_scale: float) -> tuple[float, float]:
    width = float(page.rect.width)
    height = float(page.rect.height)
    if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
        raise ResourceBoundaryError("PDF_PAGE_DIMENSIONS_INVALID", "PDF page dimensions are invalid")
    projected_width = math.ceil(width * render_scale)
    projected_height = math.ceil(height * render_scale)
    if projected_width * projected_height > max_pdf_page_render_pixels():
        raise ResourceBoundaryError(
            "PDF_PAGE_DIMENSIONS_EXCEEDED",
            f"PDF rendered page dimensions exceed the worker safety limit: {projected_width}x{projected_height}",
        )
    return width, height


def backend_candidates(requested: str | None = None, machine: str | None = None) -> list[str]:
    requested = str(requested if requested is not None else os.environ.get("OCR_BACKEND", "auto")).strip().lower()
    if requested in {"", "auto"}:
        machine = str(machine if machine is not None else platform.machine()).strip().lower()
        # OpenVINO can pass a one-shot smoke test on ARM64 but has been observed
        # to exhaust container memory on the second inference. ONNXRuntime is
        # the stable backend for repeated ARM64 OCR requests.
        return (
            ["onnxruntime", "openvino"]
            if machine in {"aarch64", "arm64"}
            else ["openvino", "onnxruntime"]
        )
    return [requested]


def load_engine():
    candidates = backend_candidates()
    errors: list[str] = []

    for candidate in candidates:
        try:
            if candidate == "openvino":
                from rapidocr_openvino import RapidOCR
                import rapidocr_openvino

                return {
                    "name": "rapidocr-openvino",
                    "version": getattr(rapidocr_openvino, "__version__", "unknown"),
                    "engine": RapidOCR(),
                }
            if candidate in {"onnx", "onnxruntime"}:
                from rapidocr_onnxruntime import RapidOCR
                import rapidocr_onnxruntime

                return {
                    "name": "rapidocr-onnxruntime",
                    "version": getattr(rapidocr_onnxruntime, "__version__", "unknown"),
                    "engine": RapidOCR(**onnx_engine_kwargs()),
                }
            errors.append(f"Unsupported OCR backend: {candidate}")
        except Exception as error:
            errors.append(f"{candidate}: {error}")

    raise RuntimeError("No OCR backend is available. " + " | ".join(errors))



def find_smoke_test_font() -> str | None:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    return None


def create_smoke_test_image(path: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    font_path = find_smoke_test_font()
    if font_path:
        image = Image.new("RGB", (960, 260), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(font_path, 76)
        small_font = ImageFont.truetype(font_path, 30)
        draw.text((44, 56), "OCR TEST 2026", fill=(0, 0, 0), font=font)
        draw.text((48, 165), "health records smoke check", fill=(0, 0, 0), font=small_font)
    else:
        image = Image.new("RGB", (240, 80), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.load_default()
        draw.text((8, 16), "OCR TEST 2026", fill=(0, 0, 0), font=font)
        draw.text((8, 42), "health records", fill=(0, 0, 0), font=font)
        image = image.resize((960, 320), Image.Resampling.NEAREST)
    image.save(path)


def run_smoke_test() -> dict[str, Any]:
    started = time.perf_counter()
    backend = load_engine()
    engine = backend["engine"]
    load_elapsed_ms = round((time.perf_counter() - started) * 1000)

    with tempfile.TemporaryDirectory(prefix="health-records-ocr-check-") as temp_name:
        image_path = Path(temp_name) / "ocr-smoke-test.png"
        create_smoke_test_image(image_path)
        recognize_started = time.perf_counter()
        lines, engine_elapsed = recognize_image(engine, image_path, None)
        recognize_elapsed_ms = round((time.perf_counter() - recognize_started) * 1000)
        repeat_started = time.perf_counter()
        repeat_lines, repeat_engine_elapsed = recognize_image(engine, image_path, None)
        repeat_elapsed_ms = round((time.perf_counter() - repeat_started) * 1000)

    texts = [str(line.get("text", "")) for line in lines]
    joined = " ".join(texts).upper()
    if "OCR" not in joined or "2026" not in joined:
        raise RuntimeError(f"OCR smoke test did not recognize expected text. recognized={texts[:8]}")
    repeat_texts = [str(line.get("text", "")) for line in repeat_lines]
    repeat_joined = " ".join(repeat_texts).upper()
    if "OCR" not in repeat_joined or "2026" not in repeat_joined:
        raise RuntimeError(
            f"OCR repeated smoke test did not recognize expected text. recognized={repeat_texts[:8]}"
        )

    return {
        "backend": backend["name"],
        "backendVersion": backend["version"],
        "engineLoadMs": load_elapsed_ms,
        "recognizeMs": recognize_elapsed_ms,
        "engineElapsed": engine_elapsed,
        "repeatRecognizeMs": repeat_elapsed_ms,
        "repeatEngineElapsed": repeat_engine_elapsed,
        "recognizedText": texts[:8],
    }


def runtime_check() -> int:
    try:
        import fitz
        import PIL
        import pillow_heif

        smoke = run_smoke_test()

        emit(
            {
                "ok": True,
                "engine": smoke["backend"],
                "modelVersion": MODEL_VERSION,
                "rapidocrVersion": smoke["backendVersion"],
                "pymupdfVersion": getattr(fitz, "version", ("unknown",))[0],
                "pillowVersion": getattr(PIL, "__version__", "unknown"),
                "pillowHeifVersion": getattr(pillow_heif, "__version__", "unknown"),
                "pythonVersion": sys.version.split()[0],
                "platform": platform.platform(),
                "machine": platform.machine(),
                "smokeTest": smoke,
            }
        )
        return 0
    except Exception as error:  # Runtime diagnostics must remain available without dependencies.
        emit(
            {
                "ok": False,
                "errorCode": "OCR_RUNTIME_UNAVAILABLE",
                "errorMessage": str(error),
                "pythonVersion": sys.version.split()[0],
                "platform": platform.platform(),
                "machine": platform.machine(),
            }
        )
        return 2


def normalize_result(result: Any, start_index: int = 0, variant: str | None = None) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    if not result:
        return lines

    for index, item in enumerate(result):
        if not item or len(item) < 3:
            continue
        box, text, confidence = item[0], item[1], item[2]
        if hasattr(box, "tolist"):
            box = box.tolist()
        line = {
            "id": f"line_{start_index + index + 1}",
            "text": str(text),
            "confidence": float(confidence),
            "box": box,
        }
        if variant:
            line["variant"] = variant
        lines.append(line)
    return lines


def dedupe_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for line in lines:
        text = str(line.get("text", "")).strip()
        key = "".join(character.lower() for character in text if character.isalnum())
        if not key:
            continue
        previous = best.get(key)
        if previous is None:
            best[key] = line
            order.append(key)
        elif float(line.get("confidence", 0)) > float(previous.get("confidence", 0)):
            best[key] = line
    return [best[key] for key in order]


def line_key(text: str) -> str:
    return "".join(character.lower() for character in text if character.isalnum())


def merge_pdf_text_and_ocr_lines(pdf_lines: list[dict[str, Any]], ocr_lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate only equal text at the same position, including signs/units."""
    merged: list[dict[str, Any]] = []
    for line in [*pdf_lines, *ocr_lines]:
        text = str(line.get("text", "")).strip()
        if not text:
            continue
        key = re.sub(r"\s+", "", unicodedata.normalize("NFKC", text)).casefold()
        bounds = line_rect(line)
        duplicate = False
        for previous in merged:
            prior_key = re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(previous.get("text", "")))).casefold()
            prior = line_rect(previous)
            if prior_key != key or not bounds or not prior:
                continue
            a,b,c,d = bounds
            x,y,z,w = prior
            overlap = max(0,min(c,z)-max(a,x))*max(0,min(d,w)-max(b,y))
            # Require substantial overlap in BOTH boxes; adjacent rows are distinct evidence.
            if overlap / max(1, (c-a)*(d-b), (z-x)*(w-y)) >= .6:
                duplicate = True
                break
        if duplicate:
            continue
        merged.append({**line, "id": f"line_{len(merged) + 1}"})

    return merged


def pdf_image_coverage(blocks: list[dict[str, Any]], page_area: float) -> float:
    if page_area <= 0:
        return 0
    image_area = 0.0
    for block in blocks:
        if block.get("type") != 1:
            continue
        bbox = block.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) < 4:
            continue
        try:
            width = max(0.0, float(bbox[2]) - float(bbox[0]))
            height = max(0.0, float(bbox[3]) - float(bbox[1]))
            image_area += width * height
        except Exception:
            continue
    return min(1.0, image_area / page_area)


def should_ocr_pdf_page(embedded_lines: list[dict[str, Any]], image_coverage: float) -> bool:
    text_length = sum(len(str(line.get("text", "")).strip()) for line in embedded_lines)
    if not embedded_lines:
        return True
    if len(embedded_lines) < 8:
        return True
    if text_length < 300:
        return True
    # A hospital PDF may contain a partial text layer plus a scanned table/image.
    # If the image area is meaningful, render the current page and merge OCR-only
    # content back into the embedded text layer. Tiny logos/seals usually stay
    # below this threshold and won't slow every digital PDF page down.
    if image_coverage >= 0.18:
        return True
    if image_coverage >= 0.06 and text_length < 1500:
        return True
    return False


def pdf_render_scale() -> float:
    try:
        requested = float(os.environ.get("OCR_PDF_RENDER_SCALE", "3") or 3)
    except Exception:
        requested = 3.0
    return max(2.0, min(4.0, requested))


def rotated_dimensions(width: float, height: float, rotation: int) -> tuple[float, float]:
    return (height, width) if rotation % 180 else (width, height)


def rotate_point_box(box: Any, rotation: int, width: float, height: float) -> list[float] | None:
    """Rotate a flat [x1, y1, x2, y2] box to match Image.rotate(-rotation, expand=True).

    The thumbnail/preview pipeline rotates pages with PIL; embedded PDF text boxes
    are reported in the unrotated page space, so they need the same transform to
    stay aligned with what the user sees.
    """
    if not isinstance(box, (list, tuple)) or len(box) < 4:
        return None
    try:
        x1, y1, x2, y2 = (float(value) for value in box[:4])
    except Exception:
        return None
    r = rotation % 360
    if not r:
        return [x1, y1, x2, y2]
    corners = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
    if r == 90:
        points = [(height - y, x) for x, y in corners]
    elif r == 180:
        points = [(width - x, height - y) for x, y in corners]
    elif r == 270:
        points = [(y, width - x) for x, y in corners]
    else:
        return [x1, y1, x2, y2]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def scale_line_boxes(lines: list[dict[str, Any]], factor: float) -> list[dict[str, Any]]:
    """Divide every box coordinate by factor (rendered pixels -> page points).

    OCR runs on a rendered bitmap while embedded PDF text uses page points. The
    stored coordinate space must be uniform per page or overlays and spatial
    label/value pairing silently mix two spaces.
    """
    if factor == 1:
        return lines
    scaled: list[dict[str, Any]] = []
    for line in lines:
        box = line.get("box")
        new_box = box
        try:
            if isinstance(box, (list, tuple)) and box:
                if isinstance(box[0], (list, tuple)):
                    new_box = [
                        [round(float(point[0]) / factor, 2), round(float(point[1]) / factor, 2)]
                        for point in box
                        if isinstance(point, (list, tuple)) and len(point) >= 2
                    ]
                elif len(box) >= 4:
                    new_box = [round(float(value) / factor, 2) for value in box[:4]]
        except Exception:
            new_box = box
        scaled.append({**line, "box": new_box})
    return scaled


def prepare_ocr_image(
    input_path: Path,
    rotation: int,
    temp_dir: Path,
) -> tuple[Path, int | None, int | None]:
    """Return the image to OCR plus its coordinate-space dimensions.

    Previews are EXIF-transposed and rotated; OCR must see the same orientation
    or line boxes land in a different space than the image the user looks at.
    Returns the original path when no correction is needed, and degrades to the
    original path without dimensions when the imaging library is unavailable.
    """
    try:
        with open_image_source(input_path) as source:
            try:
                orientation = int(source.getexif().get(0x0112, 1) or 1)
            except Exception:
                orientation = 1
            if orientation in (0, 1) and not rotation % 360:
                return input_path, int(source.size[0]), int(source.size[1])
            from PIL import ImageOps

            image = ImageOps.exif_transpose(source).convert("RGB")
            image.load()
        if rotation % 360:
            rotated = image.rotate(-rotation, expand=True)
            image.close()
            image = rotated
        prepared_path = temp_dir / "ocr-input.png"
        try:
            image.save(prepared_path, format="PNG")
            return prepared_path, int(image.width), int(image.height)
        finally:
            image.close()
    except Exception as error:
        # 方向校正失败不应阻断 OCR：退回原图并保持历史行为（无坐标系尺寸）。
        print(f"OCR image orientation normalization skipped: {error}", file=sys.stderr, flush=True)
        return input_path, None, None


def date_image_variants(image_path: Path, temp_dir: Path) -> list[tuple[str, Path]]:
    """Create lightweight variants that help dot-matrix / low-contrast date codes.

    RapidOCR handles regular package text well. Production dates are often tiny,
    reflective, or printed as pale dot-matrix codes, so we add a few CPU-cheap
    enhanced copies only for the date image role.
    """
    variants: list[tuple[str, Path]] = [("original", image_path)]
    try:
        import cv2

        image = cv2.imread(str(image_path))
        if image is None:
            return variants

        height, width = image.shape[:2]
        scale = 3 if max(height, width) < 1400 else 2
        enlarged = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)

        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        contrast = clahe.apply(gray)
        sharpened = cv2.addWeighted(contrast, 1.7, cv2.GaussianBlur(contrast, (0, 0), 1.2), -0.7, 0)
        _, otsu = cv2.threshold(sharpened, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        adaptive = cv2.adaptiveThreshold(
            sharpened,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            31,
            7,
        )
        inverted = cv2.bitwise_not(adaptive)

        generated = [
            ("date_contrast", contrast),
            ("date_sharpen", sharpened),
            ("date_binary", otsu),
            ("date_adaptive_invert", inverted),
        ]
        for label, data in generated:
            path = temp_dir / f"{label}.png"
            if cv2.imwrite(str(path), data):
                variants.append((label, path))
    except Exception as error:
        print(f"OCR date preprocessing skipped: {error}", file=sys.stderr, flush=True)
    return variants


def line_rect(line: dict[str, Any]) -> tuple[float, float, float, float] | None:
    box = line.get("box")
    if not isinstance(box, (list, tuple)) or not box:
        return None
    try:
        if isinstance(box[0], (list, tuple)):
            points = [
                (float(point[0]), float(point[1]))
                for point in box
                if isinstance(point, (list, tuple)) and len(point) >= 2
            ]
            if not points:
                return None
            xs = [point[0] for point in points]
            ys = [point[1] for point in points]
            return min(xs), min(ys), max(xs), max(ys)
        if len(box) >= 4:
            x1, y1, x2, y2 = (float(value) for value in box[:4])
            return min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)
    except Exception:
        return None
    return None


def normalized_ocr_text(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip()


TABLE_REFERENCE_PATTERN = re.compile(
    r"^\s*\(?\s*([-+]?\d+(?:\.\d+)?)\s*(?:-|–|—|~|～|至)\s*([-+]?\d+(?:\.\d+)?)\s*\)?\s*$"
)
TABLE_RESULT_PATTERN = re.compile(
    r"^\s*[↑↓▲▼⬆⬇]?(?:<=|>=|<|>|≤|≥)?\s*[-+]?\d+(?:\.\d+)?\s*(?:\(\s*[A-Za-zμµ%‰/^²³·.*×+\-\d]+\s*\)\s*)?(?:[%‰↑↓▲▼⬆⬇]|偏高|偏低|高|低)?\s*$",
    re.IGNORECASE,
)
CORRUPTED_DECIMAL_PATTERN = re.compile(r"^\s*\d+[`'’]\d+\s*[↑↓▲▼⬆⬇]?\s*$")
SUSPICIOUS_UNIT_PATTERN = re.compile(r"^(?:9|q)\s*/\s*[lL]$", re.IGNORECASE)


def table_reference(text: str) -> tuple[float, float] | None:
    match = TABLE_REFERENCE_PATTERN.match(normalized_ocr_text(text))
    if not match:
        return None
    low, high = float(match.group(1)), float(match.group(2))
    return (min(low, high), max(low, high))


def table_result_value(text: str) -> float | None:
    normalized = normalized_ocr_text(text)
    if not TABLE_RESULT_PATTERN.match(normalized):
        return None
    match = re.search(r"[-+]?\d+(?:\.\d+)?", normalized)
    if not match:
        return None
    try:
        value = float(match.group(0))
        return value if math.isfinite(value) else None
    except Exception:
        return None


def table_row_lines(
    lines: list[dict[str, Any]],
    name_rect: tuple[float, float, float, float],
    reference_rect: tuple[float, float, float, float],
) -> list[dict[str, Any]]:
    row_top = min(name_rect[1], reference_rect[1])
    row_bottom = max(name_rect[3], reference_rect[3])
    row_height = max(8.0, row_bottom - row_top)
    row_center = (row_top + row_bottom) / 2
    left = name_rect[0] - row_height * 0.4
    right = reference_rect[2] + row_height * 0.4
    matches: list[dict[str, Any]] = []
    for line in lines:
        rect = line_rect(line)
        if not rect:
            continue
        center_x = (rect[0] + rect[2]) / 2
        center_y = (rect[1] + rect[3]) / 2
        if left <= center_x <= right and abs(center_y - row_center) <= row_height * 0.65:
            matches.append(line)
    return matches


def table_result_candidates(
    row_lines: list[dict[str, Any]],
    name_rect: tuple[float, float, float, float],
    reference_rect: tuple[float, float, float, float],
) -> list[dict[str, Any]]:
    minimum_x = name_rect[0] + (name_rect[2] - name_rect[0]) * 0.72
    candidates: list[dict[str, Any]] = []
    for line in row_lines:
        rect = line_rect(line)
        if not rect:
            continue
        center_x = (rect[0] + rect[2]) / 2
        text = normalized_ocr_text(line.get("text"))
        if (
            minimum_x < center_x < reference_rect[0]
            and (
                table_result_value(text) is not None
                or CORRUPTED_DECIMAL_PATTERN.match(text)
            )
            and table_reference(text) is None
        ):
            candidates.append(line)
    return sorted(candidates, key=lambda line: line_rect(line)[0] if line_rect(line) else 0)


def suspicious_table_rows(
    lines: list[dict[str, Any]], image_width: int, image_height: int
) -> list[dict[str, Any]]:
    """Find table rows whose result or unit needs a small, local OCR retry."""
    references: list[tuple[dict[str, Any], tuple[float, float]]] = []
    for line in lines:
        reference = table_reference(str(line.get("text", "")))
        if reference:
            references.append((line, reference))

    rows: list[dict[str, Any]] = []
    for reference_line, reference in references:
        reference_rect = line_rect(reference_line)
        if not reference_rect:
            continue
        reference_center_y = (reference_rect[1] + reference_rect[3]) / 2
        reference_height = max(8.0, reference_rect[3] - reference_rect[1])
        names: list[tuple[dict[str, Any], tuple[float, float, float, float]]] = []
        for line in lines:
            rect = line_rect(line)
            text = normalized_ocr_text(line.get("text"))
            if (
                not rect
                or not re.search(r"[\u4e00-\u9fff]", text)
                or len(text) < 4
                or text.startswith("【")
                or text in {"项目名称", "参考区间", "参考范围"}
            ):
                continue
            center_y = (rect[1] + rect[3]) / 2
            if (
                rect[0] < reference_rect[0]
                # 宽版式检验单名称列与参考值列可分列页面两端；双栏防护由
                # 下方 max(rect[0]) 选取最右名称承担，不在这里限制距离。
                and reference_rect[0] - rect[0] <= image_width * 0.95
                and abs(center_y - reference_center_y) <= reference_height * 0.75
            ):
                names.append((line, rect))
        if not names:
            continue
        name_line, name_rect = max(names, key=lambda entry: entry[1][0])
        row_lines = table_row_lines(lines, name_rect, reference_rect)
        result_candidates = table_result_candidates(row_lines, name_rect, reference_rect)
        result_line = result_candidates[-1] if result_candidates else None
        result_text = normalized_ocr_text(result_line.get("text")) if result_line else ""
        result_value = table_result_value(result_text)
        result_confidence = float(result_line.get("confidence", 0)) if result_line else 0
        low, high = reference
        marker_high = any(marker in result_text for marker in ("↑", "▲", "⬆"))
        marker_low = any(marker in result_text for marker in ("↓", "▼", "⬇"))
        # 损坏（缺位/分裂/箭头矛盾）与极端值（超上限 3 倍）分开标记：
        # 极端值可能是真实的重症异常，重读只能用于核对，不能默认可替换。
        extreme_result = (
            result_value is not None and high > 0 and result_value > high * 3
        )
        corrupted_result = (
            result_line is None
            or result_confidence < 0.90
            or bool(CORRUPTED_DECIMAL_PATTERN.match(result_text))
            or (result_text[:1] in "↑↓▲▼⬆⬇" and result_value is not None)
            or (result_value is not None and marker_high and result_value <= high)
            or (result_value is not None and marker_low and result_value >= low)
        )

        result_rect = line_rect(result_line) if result_line else None
        unit_lines: list[dict[str, Any]] = []
        for line in row_lines:
            rect = line_rect(line)
            if not rect:
                continue
            center_x = (rect[0] + rect[2]) / 2
            minimum_unit_x = result_rect[2] if result_rect else name_rect[2]
            text = normalized_ocr_text(line.get("text"))
            if (
                minimum_unit_x <= center_x < reference_rect[0]
                and line is not result_line
                and re.search(r"[%‰A-Za-z/*^]", text)
                and not text.startswith("【")
            ):
                unit_lines.append(line)
        suspicious_units = [
            line
            for line in unit_lines
            if float(line.get("confidence", 0)) < 0.80
            or SUSPICIOUS_UNIT_PATTERN.match(normalized_ocr_text(line.get("text")))
        ]
        if not corrupted_result and not extreme_result and not suspicious_units:
            continue

        row_top = min(name_rect[1], reference_rect[1])
        row_bottom = max(name_rect[3], reference_rect[3])
        row_height = max(10.0, row_bottom - row_top)
        result_centers: list[float] = []
        for other_reference_line, _ in references:
            other_reference_rect = line_rect(other_reference_line)
            if (
                not other_reference_rect
                or abs(other_reference_rect[0] - reference_rect[0]) > image_width * 0.04
            ):
                continue
            other_center_y = (other_reference_rect[1] + other_reference_rect[3]) / 2
            nearby_lines = [
                line
                for line in lines
                if (rect := line_rect(line))
                and abs(((rect[1] + rect[3]) / 2) - other_center_y) <= reference_height * 0.75
            ]
            numeric_lines = [
                line
                for line in nearby_lines
                if (rect := line_rect(line))
                and rect[0] < other_reference_rect[0]
                and other_reference_rect[0] - rect[0] < image_width * 0.18
                and table_result_value(normalized_ocr_text(line.get("text"))) is not None
                and table_reference(normalized_ocr_text(line.get("text"))) is None
            ]
            if numeric_lines:
                nearest = max(numeric_lines, key=lambda line: line_rect(line)[0])
                nearest_rect = line_rect(nearest)
                result_centers.append((nearest_rect[0] + nearest_rect[2]) / 2)
        if result_rect:
            expected_result_center = (result_rect[0] + result_rect[2]) / 2
        elif result_centers:
            ordered_centers = sorted(result_centers)
            expected_result_center = ordered_centers[len(ordered_centers) // 2]
        else:
            expected_result_center = reference_rect[0] - image_width * 0.11
        crop_left = expected_result_center - row_height * 2.4
        crop_right = expected_result_center + row_height * 2.4
        if suspicious_units:
            crop_right = max(crop_right, reference_rect[0] - row_height * 0.25)
        rows.append(
            {
                "name": name_line,
                "nameRect": name_rect,
                "reference": reference,
                "referenceRect": reference_rect,
                "result": result_line,
                "resultSuspicious": corrupted_result or extreme_result,
                "resultCorrupt": corrupted_result,
                "resultExtreme": extreme_result,
                "units": suspicious_units,
                "crop": (
                    max(0, int(math.floor(crop_left))),
                    max(0, int(math.floor(row_top - row_height * 0.25))),
                    min(image_width, int(math.ceil(crop_right))),
                    min(image_height, int(math.ceil(row_bottom + row_height * 0.25))),
                ),
                "tightCrop": (
                    max(0, int(math.floor(crop_left))),
                    max(0, int(math.ceil(row_top - row_height * 0.12))),
                    min(image_width, int(math.ceil(crop_right))),
                    min(image_height, int(math.ceil(row_bottom + row_height * 0.12))),
                ),
            }
        )
    return rows[:12]


def transform_retry_lines(
    lines: list[dict[str, Any]], crop: tuple[int, int, int, int], scale: float, variant: str
) -> list[dict[str, Any]]:
    left, top, _, _ = crop
    transformed: list[dict[str, Any]] = []
    for line in lines:
        box = line.get("box")
        new_box = box
        try:
            if isinstance(box, (list, tuple)) and box and isinstance(box[0], (list, tuple)):
                new_box = [
                    [round(float(point[0]) / scale + left, 2), round(float(point[1]) / scale + top, 2)]
                    for point in box
                    if isinstance(point, (list, tuple)) and len(point) >= 2
                ]
        except Exception:
            new_box = box
        transformed.append({**line, "box": new_box, "variant": variant})
    return transformed


def retry_result_score(line: dict[str, Any], reference: tuple[float, float]) -> float:
    text = normalized_ocr_text(line.get("text"))
    value = table_result_value(text)
    if value is None:
        return -100
    low, high = reference
    score = float(line.get("confidence", 0)) * 3
    if "." in text:
        score += 0.8
    if low <= value <= high:
        score += 3
    elif high > 0 and value <= high * 3:
        score += 1
    else:
        score -= 4
    if any(marker in text for marker in ("↑", "▲", "⬆")):
        score += 2 if value > high else -3
    if any(marker in text for marker in ("↓", "▼", "⬇")):
        score += 2 if value < low else -3
    return score


def retry_replacement_allowed(row: dict[str, Any], best_value: float | None) -> bool:
    """极端真实异常值（仅因超上限 3 倍触发重读、无损坏迹象）只在校对成功时才允许替换：
    重读值必须回落到参考区间内。重读给出另一个区间外值（尤其反向越界，如 72.0→0）
    时保留原始读数——损坏形态的行不受此限制，维持原有替换逻辑。"""
    if row.get("resultExtreme") and not row.get("resultCorrupt"):
        if best_value is None:
            return False
        low, high = row["reference"]
        return low <= best_value <= high
    return True


def folded_unit_text(value: str) -> str:
    """折叠单位用于变体比对：去空白和斜杠、小写、μ 统一为 u。"""
    return re.sub(r"[\s/]+", "", value).lower().replace("μ", "u").replace("µ", "u")


def restore_inline_unit(
    original_text: str, retried_text: str, retry_row_lines: list[dict[str, Any]]
) -> str:
    """重读结果常丢掉原结果格里的括号单位（如「1.89(mmolL)↑」重读为「1.89」）。
    替换前把单位段补回：重试行中存在 fold 一致的独立单位行时采用重读文本
    （可顺带把 mmolL 矫正为 mmol/L），否则保留原单位段，避免单位丢失。"""
    original_unit = re.search(r"\(\s*([A-Za-zμµ%‰/^²³·.*×+\-]+)\s*\)", original_text)
    if not original_unit:
        return retried_text
    if re.search(r"\(\s*[A-Za-zμµ%‰/^²³·.*×+\-]+\s*\)", retried_text):
        return retried_text
    replacement_unit: str | None = None
    for line in retry_row_lines:
        text = normalized_ocr_text(line.get("text"))
        if re.search(r"\d", text):
            continue
        unit_match = re.fullmatch(r"\(?\s*([A-Za-zμµ%‰/^²³·.*×+\-]+)\s*\)?", text)
        if unit_match and folded_unit_text(unit_match.group(1)) == folded_unit_text(original_unit.group(1)):
            replacement_unit = unit_match.group(1)
            break
    unit_text = replacement_unit or original_unit.group(1)
    marker = retried_text[-1] if retried_text[-1:] in "↑↓▲▼⬆⬇" else ""
    value_part = retried_text[: len(retried_text) - len(marker)] if marker else retried_text
    return f"{value_part}({unit_text}){marker}"


def combine_retry_result_markers(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    markers = []
    for line in lines:
        text = normalized_ocr_text(line.get("text"))
        rect = line_rect(line)
        if rect and text in {"↑", "↓", "▲", "▼", "⬆", "⬇"}:
            markers.append((line, rect, text))
    combined = list(lines)
    for left in lines:
        left_text = normalized_ocr_text(left.get("text"))
        left_rect = line_rect(left)
        if not left_rect or not re.search(r"\d", left_text):
            continue
        for right in lines:
            if left is right or left.get("variant") != right.get("variant"):
                continue
            right_text = normalized_ocr_text(right.get("text"))
            right_rect = line_rect(right)
            if not right_rect or not re.search(r"\d", right_text):
                continue
            gap = right_rect[0] - left_rect[2]
            if gap < -max(30, (left_rect[2] - left_rect[0]) * 0.4) or gap > 24:
                continue
            if abs(((right_rect[1] + right_rect[3]) / 2) - ((left_rect[1] + left_rect[3]) / 2)) > 16:
                continue
            joined = f"{left_text}{right_text}"
            if left_text.endswith(".") and right_text.startswith("."):
                joined = f"{left_text}{right_text[1:]}"
            if table_result_value(joined) is None:
                continue
            combined.append(
                {
                    **left,
                    "text": joined,
                    "confidence": min(
                        float(left.get("confidence", 0)),
                        float(right.get("confidence", 0)),
                    ),
                    "box": [
                        [min(left_rect[0], right_rect[0]), min(left_rect[1], right_rect[1])],
                        [max(left_rect[2], right_rect[2]), min(left_rect[1], right_rect[1])],
                        [max(left_rect[2], right_rect[2]), max(left_rect[3], right_rect[3])],
                        [min(left_rect[0], right_rect[0]), max(left_rect[3], right_rect[3])],
                    ],
                }
            )
    for index, line in enumerate(lines):
        text = normalized_ocr_text(line.get("text"))
        rect = line_rect(line)
        if not rect or table_result_value(text) is None or any(
            marker in text for marker in "↑↓▲▼⬆⬇"
        ):
            continue
        center_y = (rect[1] + rect[3]) / 2
        nearby = [
            entry
            for entry in markers
            if entry[0].get("variant") == line.get("variant")
            and -max(18, (rect[2] - rect[0]) * 0.35)
            <= entry[1][0] - rect[2]
            <= max(18, rect[3] - rect[1])
            and abs(((entry[1][1] + entry[1][3]) / 2) - center_y)
            <= max(12, rect[3] - rect[1])
        ]
        if not nearby:
            continue
        marker_line, marker_rect, marker_text = min(nearby, key=lambda entry: entry[1][0])
        combined[index] = {
            **line,
            "text": f"{text}{marker_text}",
            "confidence": min(
                float(line.get("confidence", 0)),
                float(marker_line.get("confidence", 0)),
            ),
            "box": [
                [min(rect[0], marker_rect[0]), min(rect[1], marker_rect[1])],
                [max(rect[2], marker_rect[2]), min(rect[1], marker_rect[1])],
                [max(rect[2], marker_rect[2]), max(rect[3], marker_rect[3])],
                [min(rect[0], marker_rect[0]), max(rect[3], marker_rect[3])],
            ],
        }
    return combined


def retry_suspicious_table_rows(
    engine: Any, image_path: Path, primary_lines: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        import cv2

        image = cv2.imread(str(image_path))
        if image is None:
            return primary_lines, []
        height, width = image.shape[:2]
        rows = suspicious_table_rows(primary_lines, width, height)
        if not rows:
            return primary_lines, []

        merged = list(primary_lines)
        attempts: list[dict[str, Any]] = []
        with tempfile.TemporaryDirectory(prefix="health-records-ocr-table-") as temp_name:
            temp_dir = Path(temp_name)
            for row_index, row in enumerate(rows):
                name_text = normalized_ocr_text(row["name"].get("text"))
                contextual_unit = None
                if re.search(r"(?:血红蛋白浓度|MCHC)", name_text, re.IGNORECASE):
                    contextual_unit = "g/L"
                elif re.search(r"(?:血红蛋白含量|\bMCH\b)", name_text, re.IGNORECASE):
                    contextual_unit = "pg"
                if not row["resultSuspicious"] and row["units"] and contextual_unit:
                    for suspicious_unit in row["units"]:
                        if suspicious_unit in merged:
                            merged[merged.index(suspicious_unit)] = {
                                **suspicious_unit,
                                "text": contextual_unit,
                                "variant": "table_context_repair",
                            }
                    continue

                left, top, right, bottom = row["crop"]
                crop_image = image[top:bottom, left:right]
                if crop_image.size == 0:
                    continue
                enlarged = cv2.resize(crop_image, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
                red = enlarged[:, :, 2]
                red_contrast = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(red)
                tight_left, tight_top, tight_right, tight_bottom = row["tightCrop"]
                tight_image = image[tight_top:tight_bottom, tight_left:tight_right]
                tight_enlarged = cv2.resize(
                    tight_image, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC
                )
                gray = cv2.cvtColor(tight_enlarged, cv2.COLOR_BGR2GRAY)
                variants = (
                    ("table_upscale", enlarged, row["crop"]),
                    ("table_gray", gray, row["tightCrop"]),
                )
                retry_lines: list[dict[str, Any]] = []
                def run_variant(label: str, variant_image: Any, variant_crop: Any) -> None:
                    variant_path = temp_dir / f"row-{row_index + 1}-{label}.png"
                    if not cv2.imwrite(str(variant_path), variant_image):
                        return
                    started = time.perf_counter()
                    result, engine_elapsed = engine(str(variant_path))
                    normalized = normalize_result(result, variant=label)
                    retry_lines.extend(transform_retry_lines(normalized, variant_crop, 3, label))
                    attempts.append(
                        {
                            "row": row_index + 1,
                            "variant": label,
                            "engineElapsed": engine_elapsed,
                            "elapsedMs": round((time.perf_counter() - started) * 1000),
                        }
                    )

                for label, variant_image, variant_crop in variants:
                    run_variant(label, variant_image, variant_crop)

                preliminary_lines = combine_retry_result_markers(
                    table_row_lines(retry_lines, row["nameRect"], row["referenceRect"])
                )
                preliminary_results = table_result_candidates(
                    preliminary_lines, row["nameRect"], row["referenceRect"]
                )
                needs_red_fallback = row["resultSuspicious"] and (
                    not preliminary_results
                    or max(
                        retry_result_score(line, row["reference"])
                        for line in preliminary_results
                    )
                    < 1
                )
                if needs_red_fallback:
                    run_variant("table_red_contrast", red_contrast, row["crop"])

                retry_row_lines = combine_retry_result_markers(
                    table_row_lines(retry_lines, row["nameRect"], row["referenceRect"])
                )
                retry_results = table_result_candidates(
                    retry_row_lines, row["nameRect"], row["referenceRect"]
                )
                if row["resultSuspicious"] and retry_results:
                    best_result = max(
                        retry_results,
                        key=lambda line: retry_result_score(line, row["reference"]),
                    )
                    if retry_result_score(best_result, row["reference"]) >= 1 and (
                        # 极端真实异常值的替换守卫：重读值仍落在区间外时保留原始读数
                        retry_replacement_allowed(row, table_result_value(normalized_ocr_text(best_result.get("text"))))
                    ):
                        best_text = normalized_ocr_text(best_result.get("text"))
                        best_value = table_result_value(best_text)
                        low, high = row["reference"]
                        if best_value is not None and not any(
                            marker in best_text for marker in "↑↓▲▼⬆⬇"
                        ):
                            if best_value < low:
                                best_result = {**best_result, "text": f"{best_text}↓"}
                            elif best_value > high:
                                best_result = {**best_result, "text": f"{best_text}↑"}
                        original_result_text = (
                            normalized_ocr_text(row["result"].get("text"))
                            if row["result"]
                            else ""
                        )
                        restored_text = restore_inline_unit(
                            original_result_text,
                            normalized_ocr_text(best_result.get("text")),
                            retry_row_lines,
                        )
                        if restored_text != normalized_ocr_text(best_result.get("text")):
                            best_result = {**best_result, "text": restored_text}
                        if row["result"] in merged:
                            merged[merged.index(row["result"])] = best_result
                        else:
                            merged.append(best_result)

                for suspicious_unit in row["units"]:
                    unit_rect = line_rect(suspicious_unit)
                    if not unit_rect:
                        continue
                    unit_center_x = (unit_rect[0] + unit_rect[2]) / 2
                    candidates = []
                    for line in retry_row_lines:
                        rect = line_rect(line)
                        text = normalized_ocr_text(line.get("text"))
                        if not rect or not re.search(r"[%‰A-Za-z/*^]", text):
                            continue
                        center_x = (rect[0] + rect[2]) / 2
                        if abs(center_x - unit_center_x) <= max(24, unit_rect[2] - unit_rect[0]):
                            candidates.append(line)
                    if candidates:
                        best_unit = max(
                            candidates,
                            key=lambda line: float(line.get("confidence", 0))
                            - (
                                2
                                if SUSPICIOUS_UNIT_PATTERN.match(
                                    normalized_ocr_text(line.get("text"))
                                )
                                else 0
                            ),
                        )
                        best_unit_text = normalized_ocr_text(best_unit.get("text"))
                        if contextual_unit == "g/L":
                            best_unit = {
                                **best_unit,
                                "text": "g/L",
                                "variant": "table_context_repair",
                            }
                        elif contextual_unit == "pg":
                            best_unit = {
                                **best_unit,
                                "text": "pg",
                                "variant": "table_context_repair",
                            }
                        if suspicious_unit in merged:
                            merged[merged.index(suspicious_unit)] = best_unit

        merged.sort(
            key=lambda line: (
                round(((line_rect(line) or (0, 0, 0, 0))[1]) / 8),
                (line_rect(line) or (0, 0, 0, 0))[0],
            )
        )
        return [
            {**line, "id": f"line_{index + 1}"} for index, line in enumerate(merged)
        ], attempts
    except Exception as error:
        print(f"OCR table retry skipped: {error}", file=sys.stderr, flush=True)
        return primary_lines, []


def enhance_page_lines(image_path, lines, scale=1):
    from table_structure import enhance
    enhanced = enhance(image_path, scale_line_boxes(lines, 1 / scale))
    # Keep canonical evidence coordinates; only carry structural annotations back.
    return [{**line, **{key: item[key] for key in ("tableCell", "tableUnsafe", "tableDiagnostics") if key in item}}
            for line, item in zip(lines, enhanced)]


def recognize_image(engine: Any, image_path: Path, image_role: str | None, enhance_tables: bool = True) -> tuple[list[dict[str, Any]], Any]:
    if image_role != "date":
        result, engine_elapsed = engine(str(image_path))
        primary_lines = normalize_result(result)
        lines, table_attempts = retry_suspicious_table_rows(engine, image_path, primary_lines)
        if enhance_tables:
            lines = enhance_page_lines(image_path, lines)
        if not table_attempts:
            return lines, engine_elapsed
        return lines, {
            "source": "primary_plus_table_retry",
            "primary": engine_elapsed,
            "tableRetries": table_attempts,
        }

    all_lines: list[dict[str, Any]] = []
    elapsed_parts: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="health-records-ocr-") as temp_name:
        variants = date_image_variants(image_path, Path(temp_name))
        for label, variant_path in variants:
            started = time.perf_counter()
            result, engine_elapsed = engine(str(variant_path))
            elapsed_parts.append(
                {
                    "variant": label,
                    "engineElapsed": engine_elapsed,
                    "elapsedMs": round((time.perf_counter() - started) * 1000),
                }
            )
            all_lines.extend(normalize_result(result, len(all_lines), label))

    return dedupe_lines(all_lines), {"variants": elapsed_parts}


def recognize_input(
    engine: Any,
    input_path: Path,
    image_role: str | None,
    page_number: int | None,
    rotation: int = 0,
) -> tuple[list[dict[str, Any]], Any, dict[str, float] | None]:
    if input_path.suffix.lower() != ".pdf":
        validate_image_dimensions(input_path)
        with tempfile.TemporaryDirectory(prefix="health-records-ocr-img-") as temp_name:
            ocr_path, coord_width, coord_height = prepare_ocr_image(
                input_path, rotation, Path(temp_name)
            )
            lines, engine_elapsed = recognize_image(engine, ocr_path, image_role)
        coord = None
        if coord_width and coord_height:
            coord = {
                "coordWidth": float(coord_width),
                "coordHeight": float(coord_height),
            }
        return lines, engine_elapsed, coord

    import fitz

    with open_pdf_document(input_path) as document:
        page_count = validate_pdf_document(document)
        index = max(0, (page_number or 1) - 1)
        if index >= page_count:
            raise IndexError(f"PDF page does not exist: {page_number}")
        page = pdf_operation(lambda: document.load_page(index))
        validate_pdf_page(page, pdf_render_scale())
        base_width = float(page.rect.width)
        base_height = float(page.rect.height)
        coord_width, coord_height = rotated_dimensions(base_width, base_height, rotation)
        coord = {"coordWidth": float(coord_width), "coordHeight": float(coord_height)}
        embedded = pdf_operation(lambda: page.get_text("dict"))
        blocks = embedded.get("blocks", [])
        image_coverage = pdf_image_coverage(blocks, base_width * base_height)
        has_image_blocks = image_coverage > 0
        embedded_lines: list[dict[str, Any]] = []
        for block in blocks:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                text = "".join(span.get("text", "") for span in line.get("spans", [])).strip()
                if text:
                    box = line.get("bbox", [])
                    if rotation % 360:
                        box = rotate_point_box(box, rotation, base_width, base_height) or []
                    embedded_lines.append(
                        {
                            "id": f"line_{len(embedded_lines) + 1}",
                            "text": text,
                            "confidence": 1.0,
                            "box": box,
                            "variant": "pdf_text",
                        }
                    )
        del embedded, blocks
        if not should_ocr_pdf_page(embedded_lines, image_coverage):
            from table_structure import enhance
            if os.environ.get("OCR_TABLE_ENHANCEMENT", "auto") != "off" and (Path(os.environ.get("STORAGE_DIR", ".data")) / "ocr-table/active.json").exists():
                try:
                    with tempfile.TemporaryDirectory(prefix="health-table-pdf-") as temp_name:
                        image_path = Path(temp_name) / "page.png"
                        render_scale = pdf_render_scale()
                        pixmap = pdf_operation(lambda: page.get_pixmap(matrix=fitz.Matrix(render_scale, render_scale), alpha=False))
                        from PIL import Image
                        with Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples) as image:
                            with image.rotate(-rotation, expand=True) as rotated:
                                rotated.save(image_path)
                        del pixmap
                        embedded_lines = enhance_page_lines(image_path, embedded_lines, render_scale)
                except Exception:
                    pass  # Optional structure inference must not break valid PDF text.
            return embedded_lines, {
                "source": "pdf_text",
                "page": index + 1,
                "pdfTextLines": len(embedded_lines),
                "hasImageBlocks": has_image_blocks,
                "imageCoverage": round(image_coverage, 4),
            }, coord

        with tempfile.TemporaryDirectory(prefix="health-record-pdf-") as temp_name:
            image_path = Path(temp_name) / f"page-{index + 1}.png"
            render_scale = pdf_render_scale()
            pixmap = pdf_operation(
                lambda: page.get_pixmap(matrix=fitz.Matrix(render_scale, render_scale), alpha=False)
            )
            if rotation % 360:
                from PIL import Image

                rendered = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                del pixmap
                rotated = rendered.rotate(-rotation, expand=True)
                rendered.close()
                try:
                    rotated.save(image_path, format="PNG")
                finally:
                    rotated.close()
            else:
                pdf_operation(lambda: pixmap.save(image_path), "PDF page render cannot be decoded")
                del pixmap
            ocr_lines, elapsed = recognize_image(engine, image_path, image_role, enhance_tables=False)
            ocr_lines = scale_line_boxes(ocr_lines, render_scale)
            if embedded_lines:
                lines = merge_pdf_text_and_ocr_lines(embedded_lines, ocr_lines)
                lines = enhance_page_lines(image_path, lines, render_scale)
                return lines, {
                    "source": "pdf_text_plus_render",
                    "page": index + 1,
                    "renderScale": render_scale,
                    "pdfTextLines": len(embedded_lines),
                    "ocrLines": len(ocr_lines),
                    "mergedLines": len(lines),
                    "hasImageBlocks": has_image_blocks,
                    "imageCoverage": round(image_coverage, 4),
                    "ocr": elapsed,
                }, coord
            ocr_lines = enhance_page_lines(image_path, ocr_lines, render_scale)
            return ocr_lines, {
                "source": "pdf_render",
                "page": index + 1,
                "renderScale": render_scale,
                "ocrLines": len(ocr_lines),
                "hasImageBlocks": has_image_blocks,
                "imageCoverage": round(image_coverage, 4),
                "ocr": elapsed,
            }, coord


def inspect_pdf(input_path: Path) -> dict[str, Any]:
    import fitz

    with open_pdf_document(input_path) as document:
        page_count = validate_pdf_document(document)
        pages = []
        render_scale = pdf_render_scale()
        for index in range(page_count):
            page = pdf_operation(lambda: document.load_page(index))
            width, height = validate_pdf_page(page, render_scale)
            pages.append(
                {
                    "pageNumber": index + 1,
                    "width": round(width),
                    "height": round(height),
                }
            )
            del page
        return {"pageCount": page_count, "pages": pages}


def create_thumbnail(
    input_path: Path,
    output_path: Path,
    page_number: int | None,
    rotation: int,
    max_size: int = 480,
    quality: int = 82,
    render_scale: float | None = None,
) -> dict[str, Any]:
    from PIL import Image

    if input_path.suffix.lower() == ".pdf":
        import fitz

        with open_pdf_document(input_path) as document:
            page_count = validate_pdf_document(document)
            index = max(0, (page_number or 1) - 1)
            if index >= page_count:
                raise IndexError(f"PDF page does not exist: {page_number}")
            safe_render_scale = max(1.0, min(4.0, float(render_scale or 1.2)))
            page = pdf_operation(lambda: document.load_page(index))
            validate_pdf_page(page, safe_render_scale)
            pixmap = pdf_operation(
                lambda: page.get_pixmap(matrix=fitz.Matrix(safe_render_scale, safe_render_scale), alpha=False)
            )
            image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
            del pixmap
    else:
        from PIL import ImageOps

        validate_image_dimensions(input_path)
        try:
            with open_image_source(input_path) as source:
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.load()
        except ResourceBoundaryError:
            raise
        except InputDecodeError:
            raise
        except Exception as error:
            raise InputDecodeError("IMAGE_DECODE_FAILED", "Image file cannot be decoded") from error

    try:
        if rotation:
            rotated = image.rotate(-rotation, expand=True)
            with suppress(Exception):
                image.close()
            image = rotated
        safe_max_size = max(240, min(2400, int(max_size or 480)))
        safe_quality = max(60, min(95, int(quality or 82)))
        image.thumbnail((safe_max_size, safe_max_size), Image.Resampling.LANCZOS)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, format="JPEG", quality=safe_quality, optimize=True)
        return {"width": image.width, "height": image.height, "outputPath": str(output_path)}
    finally:
        with suppress(Exception):
            image.close()


def assemble_pdf(input_path: Path, output_path: Path, pages: list[dict[str, Any]]) -> dict[str, Any]:
    """Build a portable PDF from ordered PDF/image source pages without changing source PDFs."""
    import fitz
    from PIL import ImageOps

    output = fitz.open()
    try:
        for item in pages:
            source_path = Path(str(item["path"]))
            mime_type = str(item.get("mimeType") or "")
            rotation = int(item.get("rotation") or 0) % 360
            if mime_type == "application/pdf" or source_path.suffix.lower() == ".pdf":
                with open_pdf_document(source_path) as source:
                    page_number = int(item.get("sourcePageNumber") or 1) - 1
                    if page_number < 0 or page_number >= source.page_count:
                        raise IndexError(f"PDF page does not exist: {page_number + 1}")
                    output.insert_pdf(source, from_page=page_number, to_page=page_number)
                if rotation:
                    output[-1].set_rotation(rotation)
                continue

            validate_image_dimensions(source_path)
            with open_image_source(source_path) as source:
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.load()
            try:
                if rotation:
                    rotated = image.rotate(-rotation, expand=True)
                    image.close()
                    image = rotated
                image_bytes = io.BytesIO()
                image.save(image_bytes, format="JPEG", quality=92, optimize=True)
                page = output.new_page(width=image.width, height=image.height)
                page.insert_image(page.rect, stream=image_bytes.getvalue())
            finally:
                image.close()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output.save(str(output_path), garbage=3, deflate=True)
        return {"outputPath": str(output_path), "pageCount": len(pages)}
    finally:
        output.close()


def run_daemon() -> int:
    emit(
        {
            "type": "ready",
            "ok": True,
            "engine": ENGINE_NAME,
            "modelVersion": MODEL_VERSION,
            "capabilities": ["inspect_pdf", "thumbnail", "ocr"],
        }
    )
    backend = None
    engine = None
    request_count = 0
    ocr_request_count = 0

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        request_id = None
        action = None
        request = None
        recycle_after_response = False
        heartbeat = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            image_path = Path(request["imagePath"])
            action = str(request.get("action") or "ocr")
            recycle_after_response = bool(request.get("recycleAfterResponse"))
            page_number = request.get("pageNumber")
            request_count += 1
            if action == "ocr":
                ocr_request_count += 1
            validate_input_file(image_path)
            validate_input_format(image_path, action, request.get("mimeType"))

            started = time.perf_counter()
            heartbeat = RequestHeartbeat(request_id, action, started)
            heartbeat.start()
            if action == "inspect_pdf":
                result = inspect_pdf(image_path)
            elif action == "assemble_pdf":
                result = assemble_pdf(
                    image_path,
                    Path(request["outputPath"]),
                    list(request.get("pages") or []),
                )
            elif action == "thumbnail":
                result = create_thumbnail(
                    image_path,
                    Path(request["outputPath"]),
                    int(page_number) if page_number is not None else None,
                    int(request.get("rotation") or 0),
                    int(request.get("maxSize") or 480),
                    int(request.get("quality") or 82),
                    float(request.get("renderScale") or 0) or None,
                )
            elif action == "ocr":
                if image_path.suffix.lower() == ".pdf":
                    import fitz

                    with open_pdf_document(image_path) as document:
                        page_count = validate_pdf_document(document)
                        index = max(0, (int(page_number) if page_number is not None else 1) - 1)
                        if index >= page_count:
                            raise IndexError(f"PDF page does not exist: {page_number}")
                        page = pdf_operation(lambda: document.load_page(index))
                        validate_pdf_page(page, pdf_render_scale())
                else:
                    validate_image_dimensions(image_path)
                if engine is None:
                    backend = load_engine()
                    engine = backend["engine"]
                lines, engine_elapsed, coord = recognize_input(
                    engine,
                    image_path,
                    str(request.get("imageRole") or ""),
                    int(page_number) if page_number is not None else None,
                    int(request.get("rotation") or 0),
                )
                result = {
                    "engine": backend["name"] if backend else ENGINE_NAME,
                    "modelVersion": MODEL_VERSION,
                    "lines": lines,
                    "engineElapsed": engine_elapsed,
                }
                if coord:
                    result.update(coord)
            else:
                raise ValueError(f"Unsupported worker action: {action}")
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            heartbeat.stop()
            heartbeat = None
            release_request_resources()
            rss_bytes = process_rss_bytes()
            peak_rss_bytes = process_peak_rss_bytes()
            recycle_reason = worker_recycle_reason(
                action,
                recycle_after_response,
                ocr_request_count,
                rss_bytes,
            )
            emit(
                {
                    "id": request_id,
                    "ok": True,
                    "elapsedMs": elapsed_ms,
                    "workerRssBytes": rss_bytes,
                    "workerPeakRssBytes": peak_rss_bytes,
                    "workerRequestCount": request_count,
                    "workerOcrRequestCount": ocr_request_count,
                    "recycleRecommended": recycle_reason is not None,
                    "recycleReason": recycle_reason,
                    **result,
                }
            )
        except Exception as error:
            if heartbeat is not None:
                heartbeat.stop()
                heartbeat = None
            if action in {"thumbnail", "assemble_pdf"}:
                raw_output_path = request.get("outputPath") if isinstance(request, dict) else None
                cleanup_partial_output(Path(raw_output_path) if raw_output_path else None)
            if isinstance(error, WorkerInputError):
                print(f"{error.code}: {error}", file=sys.stderr, flush=True)
            else:
                print(traceback.format_exc(), file=sys.stderr, flush=True)
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "errorCode": getattr(error, "code", "WORKER_TASK_FAILED"),
                    "errorMessage": str(error),
                }
            )

        # The server closes stdin only after accepting the response when a
        # recycle is requested. Waiting for EOF avoids an exit-vs-stdout race
        # where the process exit event could otherwise beat the final response.

    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    return runtime_check() if args.check else run_daemon()


if __name__ == "__main__":
    raise SystemExit(main())
