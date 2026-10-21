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
                engine = RapidOCR()

                return {
                    "name": "rapidocr-openvino",
                    "version": getattr(rapidocr_openvino, "__version__", "unknown"),
                    "engine": lambda image, **kwargs: engine(image, **{"return_word_box": True, **kwargs}),
                }
            if candidate in {"onnx", "onnxruntime"}:
                from rapidocr_onnxruntime import RapidOCR
                import rapidocr_onnxruntime
                engine = RapidOCR(**onnx_engine_kwargs())

                return {
                    "name": "rapidocr-onnxruntime",
                    "version": getattr(rapidocr_onnxruntime, "__version__", "unknown"),
                    "engine": lambda image, **kwargs: engine(image, **{"return_word_box": True, **kwargs}),
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
        # Word positions can separate columns which the text detector joined.
        # Use real recognition positions, not a proportional split of values.
        words = []
        bounds = line_rect({'box': box})
        if len(item) >= 6 and bounds and bounds[2]-bounds[0] > (bounds[3]-bounds[1])*1.5:
            boxes, texts, scores = item[3:6]
            if (isinstance(boxes, (list, tuple)) and isinstance(texts, (list, tuple))
                    and isinstance(scores, (list, tuple)) and len(boxes) == len(texts) == len(scores)
                    and ''.join(str(value) for value in texts).replace(' ', '') == str(text).replace(' ', '')):
                for word_box, word, score in zip(boxes, texts, scores):
                    word_bounds = line_rect({'box': word_box})
                    if not word_bounds or not isinstance(score, (float, int)) or not math.isfinite(score):
                        words = []
                        break
                    words.append((word_bounds, str(word), float(score)))
        if any(words[index][0][0] < words[index-1][0][0] for index in range(1, len(words))):
            words = []  # An unverified classifier flip cannot supply column positions.
        groups = []
        # Packed headings have known semantic boundaries. Use actual glyph
        # positions rather than distributing their box evenly by text length.
        compact = re.sub(r'\s+', '', str(text))
        labels = re.findall(r'项目名称|检验项目|检测项目|测定项目|参考范围|参考区间|参考值|本次结果|检验结果|检查结果|结果|单位|序号|序|名称|项目', compact)
        if words and len(labels) > 1 and ''.join(labels) == compact:
            pending = []
            label_index = 0
            for word in words:
                if not word[1].strip():
                    continue
                pending.append(word)
                joined = ''.join(w[1] for w in pending)
                if label_index >= len(labels) or not labels[label_index].startswith(joined):
                    groups = []
                    break
                if joined == labels[label_index]:
                    groups.append(pending)
                    pending = []
                    label_index += 1
            if pending or label_index != len(labels):
                groups = []
        spacing = []
        for word in ([] if groups else words):
            if not word[1].strip():
                # Space boxes fill the inter-column gap. Measure between the
                # actual glyphs, retaining spaces only inside the same field.
                spacing.append(word)
                continue
            b = word[0]
            if groups and b[0] >= groups[-1][-1][0][0] and b[0]-groups[-1][-1][0][2] <= min(b[3]-b[1], groups[-1][-1][0][3]-groups[-1][-1][0][1])*.65:
                groups[-1].extend(spacing)
                groups[-1].append(word)
            else:
                groups.append([word])
            spacing = []
        if len(groups) > 1:
            for group_index, group in enumerate(groups):
                left, top = min(w[0][0] for w in group), min(w[0][1] for w in group)
                right, bottom = max(w[0][2] for w in group), max(w[0][3] for w in group)
                lines.append({'id': f'line_{start_index+index+1}_{group_index}',
                    'text': ''.join(w[1] for w in group),
                    # Match recognition's mean confidence for this field;
                    # synthetic space scores must not veto a readable value.
                    'confidence': sum(w[2]*len(w[1].strip()) for w in group) / sum(len(w[1].strip()) for w in group),
                    'box': [[left,top],[right,top],[right,bottom],[left,bottom]],
                    **({'variant': variant} if variant else {})})
            continue
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


def uncovered_pdf_image_regions(blocks, width, height):
    """Find wide image regions missing a text layer, excluding small logos."""
    text_boxes = [line.get('bbox') for block in blocks if block.get('type') == 0
                  for line in block.get('lines', [])
                  if any(str(span.get('text','')).strip() for span in line.get('spans', []))]
    regions = []
    for block in blocks:
        box = block.get('bbox')
        if block.get('type') != 1 or not isinstance(box,(list,tuple)) or len(box) != 4:
            continue
        x1,y1,x2,y2 = map(float,box)
        if not all(math.isfinite(v) for v in (x1,y1,x2,y2)):
            continue
        area = max(0,x2-x1)*max(0,y2-y1)
        if x2-x1 < width*.3 or y2-y1 < 24 or area < width*height*.012:
            continue
        covered = False
        for text_box in text_boxes:
            if not isinstance(text_box,(list,tuple)) or len(text_box) != 4:
                continue
            a,b,c,d = text_box
            overlap = max(0,min(x2,c)-max(x1,a))*max(0,min(y2,d)-max(y1,b))
            if overlap / max(1,(c-a)*(d-b)) >= .6:
                covered = True
                break
        if not covered and list(box) not in regions:
            regions.append(list(box))
    ranked = sorted(regions,key=lambda box:(box[2]-box[0])*(box[3]-box[1]),reverse=True)
    return [candidate['crop'] for candidate in dedupe_crop_candidates([{'crop':box} for box in ranked])]


def empty_retry_budget():
    return dict(rowCandidates=0,rowRetried=0,rowRemaining=0,
                cellCandidates=0,cellRetried=0,cellRemaining=0,
                imageCandidates=0,imageRetried=0,imageRemaining=0,
                rowUnresolved=0,cellUnresolved=0,imageUnresolved=0,
                retryCalls=0,retryPixels=0,
                retryCallLimit=bounded_resource_limit('OCR_RETRY_MAX_CALLS_PER_PAGE',24,0,100),
                retryPixelLimit=bounded_resource_limit('OCR_RETRY_MAX_PIXELS_PER_PAGE',24000000,0,200000000))


class PageRetryContext:
    """One bounded pool for optional OCR, including all image regions of a PDF page."""
    def __init__(self, budget=None):
        self.budget = budget if budget is not None else empty_retry_budget()
        for key,value in empty_retry_budget().items():
            self.budget.setdefault(key,value)

    def available(self, pixels):
        budget = self.budget
        return (budget['retryCalls'] < budget['retryCallLimit'] and pixels > 0
                and budget['retryPixels'] + pixels <= budget['retryPixelLimit'])

    def reserve(self, pixels):
        if not self.available(pixels):
            return False
        budget = self.budget
        budget['retryCalls'] += 1
        budget['retryPixels'] += pixels
        return True


def dedupe_crop_candidates(candidates, box_key='crop'):
    """Keep the first (highest risk) candidate when crops are almost identical."""
    unique = []
    for candidate in candidates:
        a,b,c,d = candidate[box_key]
        duplicate = False
        for other in unique:
            if candidate.get('kind') != other.get('kind'):
                continue
            x,y,z,w = other[box_key]
            overlap = max(0,min(c,z)-max(a,x))*max(0,min(d,w)-max(b,y))
            union = max(0,c-a)*max(0,d-b)+max(0,z-x)*max(0,w-y)-overlap
            if overlap / max(1,union) >= .9:
                duplicate = True
                break
        if not duplicate:
            unique.append(candidate)
    return unique


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


def photo_perspective_variant(image_path, temp_dir):
    """Rectify only a complete, high-contrast paper boundary with moderate perspective."""
    try:
        import cv2
        import numpy as np
        image = cv2.imread(str(image_path))
        if image is None:
            return None
        height,width = image.shape[:2]
        scale = min(1.,1200/max(height,width))
        small = cv2.resize(image,None,fx=scale,fy=scale)
        gray = cv2.cvtColor(small,cv2.COLOR_BGR2GRAY)
        if min(float(np.median(patch)) for patch in (
                gray[:5,:5],gray[:5,-5:],gray[-5:,:5],gray[-5:,-5:])) > 210:
            return None  # Ordinary white scans need no contour inference.
        _,mask = cv2.threshold(gray,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
        edges = cv2.morphologyEx(cv2.Canny(gray,25,75),cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
        for binary in (mask,edges):
            contours,_ = cv2.findContours(binary,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            for contour in sorted(contours,key=cv2.contourArea,reverse=True)[:3]:
                quad = cv2.approxPolyDP(contour,.02*cv2.arcLength(contour,True),True)
                if len(quad) != 4 or not cv2.isContourConvex(quad):
                    continue
                quad = quad.reshape(4,2).astype(np.float32)
                if not .3 <= cv2.contourArea(quad)/gray.size <= .92:
                    continue
                if (quad[:,0].min()<3 or quad[:,1].min()<3
                        or quad[:,0].max()>gray.shape[1]-4 or quad[:,1].max()>gray.shape[0]-4):
                    continue  # Cropped paper edges cannot establish a safe homography.
                center = quad.mean(axis=0)
                contrasts = []
                for i in range(4):
                    start,end = quad[i],quad[(i+1)%4]
                    delta = end-start
                    normal = np.array([-delta[1],delta[0]])/np.linalg.norm(delta)
                    if np.dot(center-(start+end)/2,normal)<0:
                        normal = -normal
                    def sample(point):
                        x,y = np.round(point).astype(int)
                        return float(np.median(gray[max(0,y-1):min(gray.shape[0],y+2),max(0,x-1):min(gray.shape[1],x+2)]))
                    contrasts.append(np.median([sample(start+t*delta+normal*5)-sample(start+t*delta-normal*5)
                                                for t in (.25,.5,.75)]))
                if not all(math.isfinite(float(value)) and value>=20 for value in contrasts):
                    continue  # A shadow inside the paper must not become a paper edge.
                sums,differences = quad.sum(axis=1),np.diff(quad,axis=1).ravel()
                ordered = np.array([quad[np.argmin(sums)],quad[np.argmin(differences)],
                                    quad[np.argmax(sums)],quad[np.argmax(differences)]])/scale
                if len(np.unique(ordered,axis=0))!=4:
                    continue
                top,bottom = np.linalg.norm(ordered[1]-ordered[0]),np.linalg.norm(ordered[2]-ordered[3])
                left,right = np.linalg.norm(ordered[3]-ordered[0]),np.linalg.norm(ordered[2]-ordered[1])
                ratios = (min(top,bottom)/max(top,bottom),min(left,right)/max(left,right))
                if min(ratios)<.6 or min(ratios)>.9:
                    continue  # Keep scans and small rotations on their existing path.
                out_width,out_height = round(max(top,bottom)),round(max(left,right))
                if min(out_width,out_height)<150 or out_width*out_height>width*height:
                    continue
                target = np.float32([[0,0],[out_width-1,0],[out_width-1,out_height-1],[0,out_height-1]])
                matrix = cv2.getPerspectiveTransform(ordered.astype(np.float32),target)
                corrected = cv2.warpPerspective(image,matrix,(out_width,out_height),borderValue=(255,255,255))
                path = Path(temp_dir)/'photo-perspective.png'
                if cv2.imwrite(str(path),corrected):
                    return path,np.linalg.inv(matrix),width,height
        return None
    except Exception:
        return None  # Optional preparation never blocks primary OCR.


def restore_photo_coordinates(lines, inverse, width, height):
    import cv2
    import numpy as np
    restored = []
    for line in lines:
        box = line.get('box')
        if not box:
            restored.append(line)
            continue
        if not isinstance(box[0],(list,tuple)):
            x1,y1,x2,y2 = box
            box = [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
        points = cv2.perspectiveTransform(np.array([box],dtype=np.float32),inverse)[0]
        points[:,0] = np.clip(points[:,0],0,width)
        points[:,1] = np.clip(points[:,1],0,height)
        restored.append({**line,'box':points.astype(float).round(2).tolist()})
    return restored


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


def text_baseline_slope(lines: list[dict[str, Any]]) -> float:
    """Estimate only small, consistent skew from OCR quadrilaterals."""
    slopes = []
    for line in lines:
        box = line.get("box")
        if not isinstance(box, (list, tuple)) or len(box) != 4 or not isinstance(box[0], (list, tuple)):
            continue
        try:
            dx = float(box[1][0]) - float(box[0][0])
            dy = float(box[1][1]) - float(box[0][1])
            if dx >= 12 and math.isfinite(dy) and abs(dy / dx) <= math.tan(math.radians(10)):
                slopes.append(dy / dx)
        except (IndexError, TypeError, ValueError):
            continue
    if len(slopes) < 2:
        return 0.0
    slopes.sort()
    median = slopes[len(slopes) // 2]
    agreeing = [slope for slope in slopes if abs(slope - median) <= math.tan(math.radians(1.5))]
    return median if len(agreeing) >= max(2, len(slopes) * .7) else 0.0


def baseline_y(rect: tuple[float, float, float, float], slope: float) -> float:
    return (rect[1] + rect[3] - slope * (rect[0] + rect[2])) / 2


def baseline_height(rect: tuple[float, float, float, float], slope: float) -> float:
    return max(8.0, rect[3] - rect[1] - abs(slope) * (rect[2] - rect[0]))


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
SUSPICIOUS_UNIT_PATTERN = re.compile(r"^(?:(?:9|q)\s*/\s*[lL]|\d+\s*/\s*\d+|[A-Za-zµμ]+\s*/)$", re.IGNORECASE)


def standalone_unit(text: str) -> bool:
    return bool(re.fullmatch(r"(?:[%‰]|[fpnumµμ]?g|[fpnumµμ]?L|fl|ml|[A-Za-zµμ%]+/[A-Za-z]+)", text))


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
    slope: float | None = None,
) -> list[dict[str, Any]]:
    row_top = min(name_rect[1], reference_rect[1])
    row_bottom = max(name_rect[3], reference_rect[3])
    slope = text_baseline_slope(lines) if slope is None else slope
    row_height = max(baseline_height(name_rect,slope),baseline_height(reference_rect,slope)) if slope else max(8.0, row_bottom - row_top)
    row_center = (baseline_y(name_rect, slope) + baseline_y(reference_rect, slope)) / 2
    left = name_rect[0] - row_height * 0.4
    right = reference_rect[2] + row_height * 0.4
    matches: list[dict[str, Any]] = []
    for line in lines:
        rect = line_rect(line)
        if not rect:
            continue
        center_x = (rect[0] + rect[2]) / 2
        center_y = baseline_y(rect, slope)
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
    lines: list[dict[str, Any]], image_width: int, image_height: int, limit: int | None = 12
) -> list[dict[str, Any]]:
    """Find table rows whose result or unit needs a small, local OCR retry."""
    slope = text_baseline_slope(lines)
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
        reference_center_y = baseline_y(reference_rect, slope)
        reference_height = baseline_height(reference_rect,slope)
        names: list[tuple[dict[str, Any], tuple[float, float, float, float]]] = []
        for line in lines:
            rect = line_rect(line)
            text = normalized_ocr_text(line.get("text"))
            if (
                not rect
                or not (re.search(r"[\u4e00-\u9fff]", text) or re.match(r"^[A-Za-z]{2}", text))
                or len(text) < 2
                or text.startswith("【")
                or re.fullmatch(r"项目名称|参考区间|参考范围|单位|结果", text)
                or standalone_unit(text)
            ):
                continue
            center_y = baseline_y(rect, slope)
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
        row_lines = table_row_lines(lines, name_rect, reference_rect, slope)
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
        row_height = max(10.0,baseline_height(name_rect,slope),baseline_height(reference_rect,slope)) if slope else max(10.0, row_bottom - row_top)
        result_centers: list[float] = []
        for other_reference_line, _ in references:
            other_reference_rect = line_rect(other_reference_line)
            if (
                not other_reference_rect
                or abs(other_reference_rect[0] - reference_rect[0]) > image_width * 0.04
            ):
                continue
            other_center_y = baseline_y(other_reference_rect, slope)
            nearby_lines = [
                line
                for line in lines
                if (rect := line_rect(line))
                and abs(baseline_y(rect, slope) - other_center_y) <= reference_height * 0.75
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
        if slope:
            row_center = (baseline_y(name_rect, slope) + baseline_y(reference_rect, slope)) / 2
            row_top = min(row_center + slope * crop_left, row_center + slope * crop_right) - row_height / 2
            row_bottom = max(row_center + slope * crop_left, row_center + slope * crop_right) + row_height / 2
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
                "slope": slope,
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
    # Low-confidence result cells also deserve rereading without a reference
    # interval. Require a unique adjacent item; never use a reference as a value.
    existing = {id(row['result']) for row in rows if row['result']}
    for result_line in lines:
        text = normalized_ocr_text(result_line.get('text'))
        rect = line_rect(result_line)
        if not rect or id(result_line) in existing or float(result_line.get('confidence', 0)) >= .90:
            continue
        if table_result_value(text) is None and not CORRUPTED_DECIMAL_PATTERN.match(text):
            continue
        if table_reference(text) is not None:
            continue
        x1,y1,x2,y2 = rect
        h = baseline_height(rect,slope)
        names = [line for line in lines if (b := line_rect(line)) and b[2] <= x1
                 and x1-b[2] < image_width*.4 and abs(baseline_y(b,slope)-baseline_y(rect,slope)) < h*.65
                 and re.search(r'[\u4e00-\u9fffA-Za-z]{2}', str(line.get('text','')))
                 and not re.search(r'参考|范围|日期|编号|时间|电话|姓名|单位|reference|range|date|time|unit', str(line.get('text','')), re.I)
                 and not standalone_unit(normalized_ocr_text(line.get('text')))]
        if not names:
            continue
        name = max(names,key=lambda line:line_rect(line)[2])
        name_rect = line_rect(name)
        crop = (max(0,int(x1-h*.5)), max(0,int(y1-h*.25)), min(image_width,int(x2+h*.5)),min(image_height,int(y2+h*.25)))
        rows.append({'name':name,'nameRect':name_rect,'reference':None,
                     'referenceRect':(x2+h,y1,x2+h*2,y2),'result':result_line,
                     'resultSuspicious':True,'resultCorrupt':True,'resultExtreme':False,
                     'units':[],'crop':crop,'tightCrop':crop,'slope':slope})
    # Spend the bounded budget on missing/uncertain values before check-only extremes.
    return sorted(rows,key=lambda row:(not row['resultCorrupt'],float((row['result'] or {}).get('confidence',0))))[:limit]


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


def retry_result_score(line: dict[str, Any], reference: tuple[float, float] | None) -> float:
    text = normalized_ocr_text(line.get("text"))
    value = table_result_value(text)
    if value is None:
        return -100
    score = float(line.get("confidence", 0)) * 3
    if "." in text:
        score += 0.8
    return score


def retry_replacement_allowed(row: dict[str, Any], best_value: float | None) -> bool:
    """An out-of-range result alone never authorizes changing its value."""
    original_line = row.get('result') or {}
    original_text = normalized_ocr_text(original_line.get('text'))
    original = table_result_value(original_text)
    if re.fullmatch(r'[-+]?\d+(?:\.\d+)?[tT]', original_text):
        # Flag rereading can never authorize changing the original digits.
        return best_value is not None and float(original_text[:-1]) == best_value
    if (original is not None and float(original_line.get('confidence', 0)) >= .90
            and not CORRUPTED_DECIMAL_PATTERN.match(original_text)) or (row.get("resultExtreme") and not row.get("resultCorrupt")):
        if best_value is None:
            return False
        return original is not None and original == best_value
    return True


def consensus_retry_result(lines: list[dict[str, Any]]) -> dict[str, Any] | None:
    """At least two image variants must agree; reject competing readings."""
    groups: dict[tuple[Any, str], list[dict[str, Any]]] = {}
    for line in lines:
        rect = line_rect(line)
        if rect and any(other.get('joinedDecimal') and other.get('variant') == line.get('variant')
                        and other is not line and (outer := line_rect(other))
                        and outer[0] <= rect[0] and outer[2] >= rect[2]
                        and outer[2]-outer[0] > rect[2]-rect[0]
                        for other in lines):
            continue  # The joined decimal supersedes its own OCR fragments.
        text = normalized_ocr_text(line.get('text'))
        value = table_result_value(text)
        if value is None or float(line.get('numericConfidence',line.get('confidence',0))) < .80:
            continue
        comparator = ''.join(c for c in text if c in '<>≤≥=')
        groups.setdefault((value,comparator),[]).append(line)
    qualified = [items for items in groups.values() if len({item.get('variant') for item in items if item.get('variant')}) >= 2]
    if len(qualified) != 1:
        return None
    return max(qualified[0],key=lambda line:retry_result_score(line,None))


def microscopy_interval_rows(lines, image):
    """An isolated dash between digits contradicts a scalar microscopy reading."""
    import cv2
    height, width = image.shape[:2]
    positioned = [(line, line_rect(line)) for line in lines if line_rect(line)]
    headers = [(line, box) for line, box in positioned
               if normalized_ocr_text(line.get('text')) in ('结果', '检验结果', '本次结果', 'Result', 'Results')]
    rows = []
    for unit, ub in positioned:
        if not re.fullmatch(r'(?:个|cells?)?/[HL]PF?', normalized_ocr_text(unit.get('text')), re.I):
            continue
        h = ub[3]-ub[1]
        same_row = [(line,b) for line,b in positioned
                    if b[2] < ub[0] and abs((b[1]+b[3]-ub[1]-ub[3])/2) < h*.5]
        values = [(line,b) for line,b in same_row if re.fullmatch(r'\d{2,4}', normalized_ocr_text(line.get('text')))]
        if len(values) != 1:
            continue
        result, b = values[0]
        heading = [(line,hb) for line,hb in headers if hb[3] < b[1]
                   and hb[0]-h <= (b[0]+b[2])/2 <= hb[2]+h]
        if not heading:
            continue
        _, hb = max(heading, key=lambda item:item[1][3])
        band = [(line,box) for line,box in positioned
                if abs((box[1]+box[3]-hb[1]-hb[3])/2) < h*.7]
        if sum(line in [entry[0] for entry in headers] for line,_ in band) != 1:
            continue
        if any(re.search(r'历史|上次|前次|(?:19|20|21)\d{2}[-/.年]', str(line.get('text',''))) for line,_ in band):
            continue
        if not any(normalized_ocr_text(line.get('text')) == '单位' and box[0]-h <= ub[0] <= box[2]+h for line,box in band):
            continue
        names = [(line,box) for line,box in same_row if box[2] < b[0]
                 and re.search(r'[\u3400-\u9fffA-Za-z]{2}', str(line.get('text','')))
                 and not re.search(r'姓名|日期|时间|编号|备注', str(line.get('text','')))]
        if len(names) != 1:
            continue
        x1,y1,x2,y2 = map(int,b)
        patch = image[max(0,y1):min(height,y2),max(0,x1):min(width,x2)]
        if not patch.size:
            continue
        gray = cv2.cvtColor(patch,cv2.COLOR_BGR2GRAY)
        _,binary = cv2.threshold(gray,0,255,cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)
        _,_,stats,_ = cv2.connectedComponentsWithStats(binary)
        rh = y2-y1
        components = [tuple(map(int,s[:4])) for s in stats[1:]]
        dash = any(w >= 3 and w >= dh*2.5 and dh <= rh*.2 and rh*.2 <= y+dh/2 <= rh*.8
                   and any(lx+lw <= x and lh >= rh*.35 for lx,ly,lw,lh in components)
                   and any(rx >= x+w and rheight >= rh*.35 for rx,ry,rw,rheight in components)
                   for x,y,w,dh in components)
        if not dash:
            continue
        rh = max(8,rh)
        crop = (max(0,int(x1-rh*.6)),max(0,int(y1-rh*.4)),min(width,int(x2+rh*.6)),min(height,int(y2+rh*.4)))
        rows.append({'name':names[0][0],'nameRect':names[0][1],'reference':None,
                     'referenceRect':(x2+rh,y1,x2+rh*2,y2),'result':result,
                     'resultSuspicious':True,'resultCorrupt':True,'resultExtreme':False,
                     'units':[],'crop':crop,'tightCrop':crop,'slope':0,'intervalCandidate':True})
    return rows


def consensus_retry_interval(lines, original):
    """Restore only a separator independently read twice, never guessed digits."""
    groups = {}
    box = line_rect(original)
    for line in lines:
        rect = line_rect(line)
        if not rect or not box or abs((rect[1]+rect[3]-box[1]-box[3])/2) > (box[3]-box[1])*.6:
            continue
        if rect[0] < box[0]-(box[3]-box[1])*.5 or rect[2] > box[2]+(box[3]-box[1])*.5:
            continue
        if float(line.get('confidence',0)) < .8:
            continue
        match = re.fullmatch(r'(\d+)\s*[-–—~～]\s*(\d+)',normalized_ocr_text(line.get('text')))
        if not match or ''.join(match.groups()) != normalized_ocr_text(original.get('text')):
            return None  # A competing confident reading cannot resolve the cell.
        groups.setdefault(match.groups(),[]).append(line)
    if len(groups) != 1:
        return None
    agreed = next(iter(groups.values()))
    return max(agreed,key=lambda line:float(line.get('confidence',0))) if len({line.get('variant') for line in agreed}) >= 2 else None


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
            elif gap < 0 and ('.' in left_text or '.' in right_text):
                # Overlapping OCR boxes may repeat the digit before a decimal
                # (e.g. "12" + "2.5"). Count that shared glyph only once.
                for overlap in range(min(len(left_text), len(right_text)) - 1, 0, -1):
                    if left_text[-overlap:] == right_text[:overlap]:
                        joined = left_text + right_text[overlap:]
                        break
            if table_result_value(joined) is None:
                continue
            combined.append(
                {
                    **left,
                    "text": joined,
                    "joinedDecimal": True,
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
            "numericConfidence": float(line.get("confidence", 0)),
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
    engine: Any, image_path: Path, primary_lines: list[dict[str, Any]], budget: dict[str, int] | None = None,
    retry_context=None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    context = retry_context or PageRetryContext(budget)
    budget = context.budget
    merged = list(primary_lines)
    attempts: list[dict[str, Any]] = []
    interval_rows = []
    def protect_unresolved_intervals(items):
        # Independent pixels invalidated scalar confidence. Use the existing
        # low-confidence review path without inventing a replacement value.
        return [{**line,'confidence':min(float(line.get('confidence',0)),.64)}
                if any(line is row['result'] for row in interval_rows) else line for line in items]
    try:
        import cv2

        image = cv2.imread(str(image_path))
        if image is None:
            return primary_lines, []
        height, width = image.shape[:2]
        interval_rows = microscopy_interval_rows(primary_lines,image)
        scalar_rows = [row for row in suspicious_table_rows(primary_lines, width, height, limit=None)
                       if not any(row.get('result') is interval['result'] for interval in interval_rows)]
        candidates = dedupe_crop_candidates([*interval_rows,*scalar_rows])
        rows = candidates[:max(0,12-budget['rowRetried'])]
        budget['rowCandidates'] += len(candidates)
        budget['rowRemaining'] += len(candidates)
        if not rows:
            return protect_unresolved_intervals(primary_lines), []

        with tempfile.TemporaryDirectory(prefix="health-records-ocr-table-") as temp_name:
            temp_dir = Path(temp_name)
            for row_index, row in enumerate(rows):
                select_results = (lambda items:items) if row.get('intervalCandidate') else (lambda items:table_result_candidates(items,row['nameRect'],row['referenceRect']))
                consensus = (lambda items:consensus_retry_interval(items,row['result'])) if row.get('intervalCandidate') else consensus_retry_result
                left, top, right, bottom = row["crop"]
                crop_image = image[top:bottom, left:right]
                if crop_image.size == 0:
                    continue
                if not context.available(int(crop_image.shape[0]*crop_image.shape[1]*9)):
                    continue
                attempted = False
                result_resolved = not row['resultSuspicious']
                units_resolved = 0
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
                    nonlocal attempted
                    variant_path = temp_dir / f"row-{row_index + 1}-{label}.png"
                    if not context.available(int(variant_image.shape[0]*variant_image.shape[1])):
                        return
                    if not cv2.imwrite(str(variant_path), variant_image):
                        return
                    if not context.reserve(int(variant_image.shape[0]*variant_image.shape[1])):
                        return
                    if not attempted:
                        attempted = True
                        budget['rowRetried'] += 1
                        budget['rowRemaining'] -= 1
                        budget['rowUnresolved'] += 1
                    started = time.perf_counter()
                    try:
                        result, engine_elapsed = engine(str(variant_path))
                    except Exception:
                        attempts.append({'row':row_index+1,'variant':label,'failed':True})
                        return
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
                    table_row_lines(retry_lines, row["nameRect"], row["referenceRect"], row['slope'])
                )
                preliminary_results = select_results(preliminary_lines)
                if row["resultSuspicious"] and consensus(preliminary_results) is None:
                    # A tight crop may resolve joined glyphs while a wider one
                    # keeps a decimal intact. Give each geometry a second view.
                    run_variant("table_wide_gray", cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY), row["crop"])
                    run_variant("table_tight_rgb", tight_enlarged, row["tightCrop"])
                    preliminary_results = select_results(combine_retry_result_markers(
                        table_row_lines(retry_lines, row["nameRect"], row["referenceRect"], row['slope'])))
                needs_red_fallback = (row["resultSuspicious"] and consensus(preliminary_results) is None) or bool(row['units'])
                if needs_red_fallback:
                    run_variant("table_red_contrast", red_contrast, row["crop"])

                retry_row_lines = combine_retry_result_markers(
                    table_row_lines(retry_lines, row["nameRect"], row["referenceRect"], row['slope'])
                )
                retry_results = select_results(retry_row_lines)
                if row["resultSuspicious"] and retry_results:
                    best_result = consensus(retry_results)
                    if best_result and (
                        # Only independent dash pixels plus interval consensus
                        # can override scalar confidence; other protections stay intact.
                        row.get('intervalCandidate') or retry_replacement_allowed(row, table_result_value(normalized_ocr_text(best_result.get("text"))))
                    ):
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
                        result_resolved = True

                for suspicious_unit in row["units"]:
                    unit_rect = line_rect(suspicious_unit)
                    if not unit_rect:
                        continue
                    unit_center_x = (unit_rect[0] + unit_rect[2]) / 2
                    candidates = []
                    for line in retry_row_lines:
                        rect = line_rect(line)
                        text = normalized_ocr_text(line.get("text"))
                        if not rect or not re.fullmatch(r"(?:[%‰]|[A-Za-zµμ][A-Za-zµμ0-9/^²³·.*%×+-]*)", text):
                            continue
                        if SUSPICIOUS_UNIT_PATTERN.match(text) or re.fullmatch(r'[Pp]9', text):
                            continue
                        # Do not replace a compound unit with a cropped suffix.
                        if '/' in normalized_ocr_text(suspicious_unit.get('text')) and '/' not in text:
                            continue
                        center_x = (rect[0] + rect[2]) / 2
                        if abs(center_x - unit_center_x) <= max(24, unit_rect[2] - unit_rect[0]):
                            candidates.append(line)
                    groups = {}
                    for candidate in candidates:
                        if float(candidate.get('confidence', 0)) >= .80:
                            groups.setdefault(normalized_ocr_text(candidate.get('text')), []).append(candidate)
                    agreed = [group for group in groups.values() if len({line.get('variant') for line in group}) >= 2]
                    if len(agreed) == 1:
                        best_unit = max(
                            agreed[0],
                            key=lambda line: float(line.get("confidence", 0))
                            - (
                                2
                                if SUSPICIOUS_UNIT_PATTERN.match(
                                    normalized_ocr_text(line.get("text"))
                                )
                                else 0
                            ),
                        )
                        if suspicious_unit in merged:
                            merged[merged.index(suspicious_unit)] = best_unit
                            units_resolved += 1
                if attempted and result_resolved and units_resolved == len(row['units']):
                    budget['rowUnresolved'] -= 1

        merged.sort(
            key=lambda line: (
                round(((line_rect(line) or (0, 0, 0, 0))[1]) / 8),
                (line_rect(line) or (0, 0, 0, 0))[0],
            )
        )
        return [
            {**line, "id": f"line_{index + 1}"} for index, line in enumerate(protect_unresolved_intervals(merged))
        ], attempts
    except Exception as error:
        print(f"OCR table retry skipped: {type(error).__name__}", file=sys.stderr, flush=True)
        return protect_unresolved_intervals(merged), attempts


def header_retry_regions(lines, width, height, limit=8):
    """Bounded cell crops from explicit headers; supports short/English names.

    Blank printed cells are merely reread. A crop with no agreeing OCR text
    stays blank, and result/reference columns are never interchangeable.
    """
    roles = {'项目':'name','项目名称':'name','名称':'name','检验项目':'name','test':'name','item':'name','testname':'name','itemname':'name','testitem':'name',
             '结果':'result','检验结果':'result','本次结果':'result','result':'result','results':'result','testresult':'result','value':'result',
             '单位':'unit','unit':'unit','units':'unit','参考范围':'reference','参考值':'reference','参考区间':'reference','reference':'reference','referencerange':'reference','referenceinterval':'reference'}
    slope = text_baseline_slope(lines)
    positioned = [(line,line_rect(line)) for line in lines if line_rect(line)]
    def header_key(text):
        return re.sub(r'[\s:：]+', '', unicodedata.normalize('NFKC', str(text))).lower()
    headers = [(line,b,roles[header_key(line.get('text',''))]) for line,b in positioned if header_key(line.get('text','')) in roles]
    # Join only aligned adjacent fragments that form a known heading.
    for line,b in positioned:
        for other,ob in positioned:
            h = max(8, b[3]-b[1])
            if other is line or not (0 <= ob[1]-b[3] <= h*.8): continue
            if abs((b[0]+b[2]-ob[0]-ob[2])/2) > max(h, min(b[2]-b[0], ob[2]-ob[0])*.5): continue
            key = header_key(str(line.get('text','')) + str(other.get('text','')))
            if key not in roles: continue
            headers = [(hl,hb,role) for hl,hb,role in headers if hl is not line and hl is not other]
            headers.append((line,(min(b[0],ob[0]),b[1],max(b[2],ob[2]),ob[3]),roles[key]))
    regions = []
    for label,b,role in headers:
        if role != 'name': continue
        h = baseline_height(b,slope); cy=baseline_y(b,slope)
        next_panel = min([hb[0] for _,hb,r in headers if r=='name' and hb[0]>b[2] and abs(baseline_y(hb,slope)-cy)<h*2] or [width])
        band = sorted([(line,hb,r) for line,hb,r in headers if b[0]<=hb[0]<next_panel and abs(baseline_y(hb,slope)-cy)<h*2],key=lambda it:it[1][0])
        if sum(r=='result' for _,_,r in band)!=1: continue
        result_index = next(i for i,(_,_,r) in enumerate(band) if r=='result')
        result_box = band[result_index][1]
        result_left = (band[result_index-1][1][2]+result_box[0])/2 if result_index else result_box[0]-h
        result_right = ((result_box[2]+band[result_index+1][1][0])/2
                        if result_index+1<len(band) else result_box[2]+h*2)
        name_end = band[1][1][0]-h/2 if len(band)>1 else b[2]
        next_top = min([hb[1] for _,hb,r in headers if r=='name' and abs(hb[0]-b[0])<h and hb[1]>b[3]+h] or [height])
        footers = [rect[1] for line,rect in positioned if rect[1]>b[3]+h
                   and re.match(r'^(?:备注|说明|注释|采样时间|签收时间|报告日期|检验者|地址|D[:：]\s*\d{8})',str(line.get('text','')).strip())]
        next_top = min([next_top,*footers])
        for name,nb in positioned:
            text=str(name.get('text','')).strip()
            if not (b[0]-h*2<=nb[0]<name_end and b[3]<nb[1]<next_top): continue
            if len(text)<2 or not re.search(r'[\u4e00-\u9fffA-Za-z]',text) or re.search(r'姓名|日期|时间|编号|医生|审核|签名|备注',text): continue
            if text.lower() in roles or table_result_value(text) is not None or table_reference(text): continue
            code_only = bool(re.fullmatch(r'\[[A-Za-z][A-Za-z0-9-]{1,20}\]', text))
            if code_only:
                # A second-line code can survive when the first-line name and
                # value disappear. Reread the two-line cell, bounded by header.
                ordinals=[line for line,rect in positioned if re.fullmatch(r'\d{1,3}',str(line.get('text','')).strip())
                          and (rect[0]+rect[2])/2<nb[0] and nb[1]-h*1.3<(rect[1]+rect[3])/2<nb[3]+h*.2]
                regions.append({'kind':'name','original':name,'excludeOrdinal':True,'fragments':ordinals,'crop':(
                    max(0,int(b[0]-h)), max(int(b[3])+1,int(nb[1]-h*1.3)),
                    min(width,int(result_box[0]-2)), min(height,int(nb[3]+h*.2)))})
            elif re.search(r'\[[A-Za-z][A-Za-z0-9 -]*$',text):
                fragments=[(line,rect) for line,rect in positioned if line is not name
                           and b[0]-h*2<=rect[0]<name_end and nb[1]<rect[1]<=nb[3]+h
                           and re.fullmatch(r'[\d\sA-Za-z°℃-]*\]',str(line.get('text','')).strip())]
                if len(fragments)==1:
                    fragment,fb=fragments[0]
                    regions.append({'kind':'name','original':name,'fragments':[fragment],'crop':(
                        max(0,int(nb[0]-h*.2)),max(int(b[3])+1,int(nb[1]-h*.2)),
                        min(width,int(result_box[0]-2)),min(next_top,int(fb[3]+h*.2)))})
            for index,(_,hb,kind) in enumerate(band):
                if kind not in ('result','unit','reference'): continue
                # Headings may be centred while values are right-aligned. Use
                # the gaps between headings, not the printed heading's left edge.
                left=max(0,int((band[index-1][1][2]+hb[0])/2 if index else hb[0]-h))
                right=min(width,int((hb[2]+band[index+1][1][0])/2 if index+1<len(band) else hb[2]+h*2))
                if kind == 'result' and re.search(r'\][<>≤≥]?\s*\d+(?:\.\d+)?$', text) and nb[2] > result_left:
                    # A name+code+value box can hide a missing result cell. Crop
                    # the actual result column, not the tail of the long name.
                    left=max(left,int(result_box[0]-h))
                row_y=baseline_y(nb,slope)
                row_h=baseline_height(nb,slope)
                top=max(0,int(min(row_y+slope*left,row_y+slope*right)-row_h/2-h*.2))
                bottom=min(height,int(max(row_y+slope*left,row_y+slope*right)+row_h/2+h*.2))
                if code_only:
                    top=max(int(b[3])+1,int(top-h*1.3))
                members=[line for line,rect in positioned
                         if (rect[0]<right and rect[2]>left if kind=='unit' else left<=(rect[0]+rect[2])/2<right)
                         and abs(baseline_y(rect,slope)-row_y)<row_h/2+h*.2]
                original = None
                if kind == 'reference':
                    # The line-angle classifier can flip small numeric-only ranges.
                    # Reread printed pixels; never reverse digits or infer a range.
                    match = TABLE_REFERENCE_PATTERN.match(normalized_ocr_text(members[0].get('text'))) if len(members) == 1 else None
                    # Missing separators (including two numbers separated only by
                    # whitespace) require pixel evidence, never guessed bounds.
                    malformed = len(members) == 1 and bool(re.fullmatch(r'[\d.\s]+', str(members[0].get('text',''))))
                    if not malformed and (not match or float(match.group(1)) <= float(match.group(2))): continue
                    original = members[0]
                    original_box = line_rect(original)
                    # Tight numeric crops can repeat the angle classifier's flip.
                    # Add vertical context, stopping midway to adjacent cells.
                    column_boxes = [rect for line,rect in positioned if line is not original
                                    and left <= (rect[0]+rect[2])/2 < right]
                    previous_bottom = max([rect[3] for rect in column_boxes if rect[3] <= original_box[1]] or [0])
                    next_cell_top = min([rect[1] for rect in column_boxes if rect[1] >= original_box[3]] or [height])
                    top = max(0, int(max((previous_bottom+original_box[1])/2, min(top,original_box[1]-row_h*.6))))
                    bottom = min(height, int(min((next_cell_top+original_box[3])/2, max(bottom,original_box[3]+row_h*.6))))
                elif kind == 'unit' and len(members) == 1 and (
                        float(members[0].get('confidence', 0)) < .80
                        or SUSPICIOUS_UNIT_PATTERN.fullmatch(normalized_ocr_text(members[0].get('text')))):
                    # The unit column can follow the reference column. Even a
                    # high-confidence digit fraction requires pixel verification.
                    original = members[0]
                    # Wrapped names can sit above/below the unit baseline.
                    # Include the complete unit box rather than clipping it to
                    # one fragment of the name.
                    unit_box = line_rect(original)
                    top = max(0, int(min(top, unit_box[1] - h * .2)))
                    bottom = min(height, int(max(bottom, unit_box[3] + h * .2)))
                elif kind == 'result' and len(members) == 1 and (
                        (float(members[0].get('confidence', 0)) < .90
                         and re.fullmatch(r'[-+]?\d+(?:\.\d+)?[tT]', normalized_ocr_text(members[0].get('text'))))
                        or re.fullmatch(r'[↑↓▲▼⬆⬇]\s*[-+]?\d+(?:\.\d+)?', normalized_ocr_text(members[0].get('text')))):
                    # Reread an ambiguous flag in the explicit result column;
                    # do not strip it or change digits without pixel consensus.
                    original = members[0]
                    original_result_box = line_rect(original)
                    top = max(0, int(min(top, original_result_box[1] - h * .2)))
                    bottom = min(height, int(max(bottom, original_result_box[3] + h * .2)))
                elif members:
                    continue  # Existing ambiguous results go through row retry.
                elif kind == 'unit':
                    results = [line for line,rect in positioned
                               if result_left <= (rect[0]+rect[2])/2 < result_right
                               and abs(baseline_y(rect,slope)-row_y)<row_h/2+h*.2]
                    if len(results)==1 and re.fullmatch(
                            r'(?:阴性|阳性|弱阳性|未检出|negative|positive|not\s*detected)(?:\s*\([+-]\))?',
                            normalized_ocr_text(results[0].get('text')),re.I):
                        continue  # Explicit qualitative results legitimately have no unit.
                if right>left and bottom>top:
                    region={'kind':kind,'crop':(left,top,right,bottom)}
                    glued_result = re.search(r'\]([<>≤≥]?\s*\d+(?:\.\d+)?)$', text) if kind == 'result' else None
                    if glued_result: region['expectedResult'] = re.sub(r'\s+', '', glued_result.group(1))
                    if original is not None:region['original']=original
                    regions.append(region)
    return sorted(regions,key=lambda r:(r.get('original') is None, {'result':0,'name':1,'reference':2,'unit':3}[r['kind']]))[:limit]


def retry_missing_header_cells(engine, image_path, lines, budget=None, retry_context=None):
    import cv2
    context = retry_context or PageRetryContext(budget)
    budget = context.budget
    image=cv2.imread(str(image_path))
    if image is None: return lines,[]
    candidates=dedupe_crop_candidates(header_retry_regions(lines,image.shape[1],image.shape[0],limit=None))
    regions=candidates[:max(0,12-budget['cellRetried'])]
    budget['cellCandidates'] += len(candidates)
    budget['cellRemaining'] += len(candidates)
    added=[]; attempts=[]; merged=list(lines)
    with tempfile.TemporaryDirectory(prefix='health-ocr-cell-') as temp:
        for index,region in enumerate(regions):
            if region.get('original') is not None and region['original'] not in merged:
                # Two wrapped name fragments may target the same unit. Once
                # replaced, its second crop is redundant and must not abort the page.
                budget['cellRemaining'] -= 1
                continue
            left,top,right,bottom=region['crop']
            if not context.available((right-left)*(bottom-top)*9):
                continue
            crop=cv2.resize(image[top:bottom,left:right],None,fx=3,fy=3,interpolation=cv2.INTER_CUBIC)
            attempted=False
            groups={}
            gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
            variants = [('cell_upscale',crop),('cell_gray',gray)]
            if region['kind'] in ('reference', 'unit'):
                # Thresholding separates thin unit glyphs from tinted table
                # backgrounds. Keep the same two-view consensus and call budget.
                variants = [('cell_binary',cv2.threshold(gray,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)[1]),
                            ('cell_adaptive',cv2.adaptiveThreshold(gray,255,cv2.ADAPTIVE_THRESH_GAUSSIAN_C,cv2.THRESH_BINARY,31,11))]
                if region['kind'] == 'unit':
                    variants += [('cell_upscale',crop),('cell_gray',gray)]
            for label,variant in variants:
                path=Path(temp)/f'{index}-{label}.png'
                if not cv2.imwrite(str(path),variant): continue
                if not context.reserve(int(variant.shape[0]*variant.shape[1])): continue
                if not attempted:
                    attempted=True
                    budget['cellRetried']+=1
                    budget['cellRemaining']-=1
                    budget['cellUnresolved']+=1
                started=time.perf_counter()
                try:
                    # The explicit upright table header establishes orientation.
                    # A prefixed arrow may be a numeric cell flipped by the angle
                    # classifier. Reread pixels in that established direction.
                    direction_check = region['kind'] == 'result' and re.match(
                        r'^[↑↓▲▼⬆⬇]', str(region.get('original', {}).get('text', '')))
                    result,_=engine(str(path), use_cls=False) if direction_check else engine(str(path))
                except Exception:
                    attempts.append({'field':region['kind'],'variant':label,'failed':True})
                    continue
                retry_lines=transform_retry_lines(normalize_result(result,variant=label),region['crop'],3,label)
                if region.get('excludeOrdinal'):
                    name_left=line_rect(region['original'])[0]
                    retry_lines=[line for line in retry_lines if not (
                        re.fullmatch(r'\d{1,3}',str(line.get('text','')).strip())
                        and (line_rect(line)[0]+line_rect(line)[2])/2<name_left)]
                if region['kind']=='name' and 1<len(retry_lines)<=3:
                    parts=sorted(retry_lines,key=lambda line:line_rect(line)[1])
                    joined=''.join(str(line.get('text','')).strip() for line in parts)
                    if re.fullmatch(r'[^\[\]]+\[[A-Za-z][A-Za-z0-9%#./ -]*\]',joined) and min(float(line.get('confidence',0)) for line in parts)>=.85:
                        boxes=[line_rect(line) for line in parts]
                        retry_lines=[{**parts[0],'text':joined,'confidence':min(float(line.get('confidence',0)) for line in parts),
                                      'box':[[min(b[0] for b in boxes),min(b[1] for b in boxes)],
                                             [max(b[2] for b in boxes),min(b[1] for b in boxes)],
                                             [max(b[2] for b in boxes),max(b[3] for b in boxes)],
                                             [min(b[0] for b in boxes),max(b[3] for b in boxes)]]}]
                for line in retry_lines:
                    text=normalized_ocr_text(line.get('text'))
                    if region['kind'] == 'result' and region.get('original') is not None and not direction_check and not retry_replacement_allowed(
                            {'result': region['original']}, table_result_value(text)):
                        continue
                    if region['kind'] in ('reference', 'unit'):
                        text=re.sub(r'\s+', '', text)
                        line={**line,'text':text}
                    if region.get('expectedResult'):
                        suffix = re.search(r'(?:^|\])\s*([<>≤≥]?\d+(?:\.\d+)?)$',text)
                        if not suffix or suffix.group(1) != region['expectedResult']: continue
                        text = suffix.group(1)
                        line = {**line, 'text':text}
                    bounds=line_rect(line)
                    if not bounds or bounds[0]<=left+2 or bounds[2]>=right-2: continue
                    valid=(bool(re.search(r'[\u4e00-\u9fff]{2}',text)) and not bool(re.search(r'姓名|日期|时间|医生|审核|备注',text)) if region['kind']=='name'
                           else table_result_value(text) is not None if region['kind']=='result'
                           else table_reference(text) is not None if region['kind']=='reference'
                           else bool(re.fullmatch(r'(?:[%‰]|(?:[×x*]?\s*)?10\s*\^?\s*\d+\s*/\s*[lL]|[A-Za-zµμ][A-Za-zµμ0-9/^²³·.*%×+-]*)',text)))
                    if region['kind'] == 'unit' and SUSPICIOUS_UNIT_PATTERN.fullmatch(text):
                        valid = False
                    if region['kind'] == 'unit' and '/' in str(region.get('original', {}).get('text', '')) and '/' not in text:
                        valid = False
                    if valid and float(line.get('confidence',0))>=.85: groups.setdefault(text,[]).append(line)
                attempts.append({'field':region['kind'],'variant':label,'elapsedMs':round((time.perf_counter()-started)*1000)})
                if region['kind'] == 'unit' and len(groups)==1 and len([items for items in groups.values()
                        if len({line.get('variant') for line in items}) >= 2]) == 1:
                    break
            agreed=[items for items in groups.values() if len({line.get('variant') for line in items})>=2]
            if len(agreed)==1 and (region['kind']!='unit' or len(groups)==1):
                best=max(agreed[0],key=lambda line:float(line.get('confidence',0)))
                if region.get('original') is not None:
                    merged[merged.index(region['original'])]=best
                else:added.append(best)
                for fragment in region.get('fragments',[]):
                    if fragment in merged:merged.remove(fragment)
                reference = TABLE_REFERENCE_PATTERN.match(normalized_ocr_text(best.get('text')))
                if region['kind'] != 'reference' or (reference and float(reference.group(1)) <= float(reference.group(2))):
                    budget['cellUnresolved']-=1
    unresolved_direction = {id(region['original']) for region in candidates
                            if region['kind'] == 'result' and region.get('original') is not None
                            and re.match(r'^[↑↓▲▼⬆⬇]', str(region['original'].get('text', '')))}
    return [{**line,'id':f'line_{i+1}', **({'confidence':min(float(line.get('confidence',0)),.64)}
             if id(line) in unresolved_direction else {})}
            for i,line in enumerate([*merged,*added])],attempts


def enhance_page_lines(image_path, lines, scale=1):
    from table_structure import enhance
    enhanced = enhance(image_path, scale_line_boxes(lines, 1 / scale))
    # Keep canonical evidence coordinates; only carry structural annotations back.
    return [{**line, **{key: item[key] for key in ("tableCell", "tableUnsafe", "tableDiagnostics") if key in item}}
            for line, item in zip(lines, enhanced)]


def annotate_retry_budget(lines, budget):
    if lines and isinstance(budget,dict) and any(budget.get(key,0) for key in (
            'rowRemaining','cellRemaining','imageRemaining','rowUnresolved','cellUnresolved','imageUnresolved')):
        return [{**lines[0], 'tableRetryBudget':dict(budget)}, *lines[1:]]
    return lines


def sideways_table(lines):
    boxes = [line_rect(line) for line in lines]
    boxes = [box for box in boxes if box]
    return (len(boxes) >= 6
            and sum(b[3]-b[1] > (b[2]-b[0])*1.5 for b in boxes) >= len(boxes)*.6
            and sum(bool(re.search(r'项目|名称|结果|参考范围', str(line.get('text', '')))) for line in lines) >= 2)


def upright_table_score(lines, height):
    names = [line_rect(line) for line in lines if re.fullmatch(r'项目名称|项目|名称|检验项目', str(line.get('text', '')).strip())]
    results = [line_rect(line) for line in lines if str(line.get('text', '')).strip().startswith('结果')]
    headers = sum(any(r and n and r[0] > n[2] and n[1] < height*.5
                      and abs((r[1]+r[3]-n[1]-n[3])/2) < max(r[3]-r[1], n[3]-n[1])*2
                      for r in results) for n in names)
    readable = sum(len(str(line.get('text', ''))) * float(line.get('confidence', 0))
                   for line in lines if (box := line_rect(line)) and box[2]-box[0] > (box[3]-box[1])*1.3)
    return headers, readable


def restore_quarter_turn(lines, angle, width, height):
    restored = []
    for line in lines:
        box = line.get('box')
        if not box:
            restored.append(line)
            continue
        if not isinstance(box[0], (list, tuple)):
            left, top, right, bottom = box
            box = [[left,top],[right,top],[right,bottom],[left,bottom]]
        points = [[y, height-x] if angle == 90 else [width-y, x] for x,y in box]
        restored.append({**line, 'box': points})
    return restored


def recognize_image(engine: Any, image_path: Path, image_role: str | None, enhance_tables: bool = True,
                    retry_context=None, prepare_photo=True) -> tuple[list[dict[str, Any]], Any]:
    if image_role != "date":
        if prepare_photo and enhance_tables:
            with tempfile.TemporaryDirectory(prefix='health-photo-ocr-') as temp_name:
                prepared = photo_perspective_variant(image_path,Path(temp_name))
                if prepared is not None:
                    path,inverse,width,height = prepared
                    lines,elapsed = recognize_image(engine,path,image_role,enhance_tables,
                                                   retry_context=retry_context,prepare_photo=False)
                    return restore_photo_coordinates(lines,inverse,width,height), {
                        'source':'photo_perspective','ocr':elapsed}
        result, engine_elapsed = engine(str(image_path))
        primary_lines = normalize_result(result)
        if enhance_tables and sideways_table(primary_lines):
            from PIL import Image
            with Image.open(image_path) as image, tempfile.TemporaryDirectory(prefix='health-table-direction-') as temp_name:
                width, height = image.size
                best = None
                for angle in (90, 270):
                    path = Path(temp_name)/f'turn-{angle}.png'
                    with image.rotate(-angle, expand=True) as turned:
                        turned.save(path)
                    try:
                        candidate, elapsed = engine(str(path))
                        lines = normalize_result(candidate)
                        score = upright_table_score(lines, width)
                        if not sideways_table(lines) and score[0] and (best is None or score > best[0]):
                            best = score, angle, path, candidate, elapsed
                    except Exception:
                        continue  # A failed optional orientation cannot erase usable OCR.
                if best:
                    _, angle, path, candidate, elapsed = best
                    cached = lambda value, **kwargs: (candidate, elapsed) if str(value) == str(path) and not kwargs else engine(value, **kwargs)
                    lines, metadata = recognize_image(cached, path, image_role, enhance_tables, retry_context, prepare_photo=False)
                    return restore_quarter_turn(lines, angle, width, height), {
                        'source': 'quarter_turn_table', 'rotation': angle, 'ocr': metadata}
        context = retry_context or PageRetryContext()
        budget = context.budget
        lines, table_attempts = primary_lines, []
        try:
            lines, cell_attempts = retry_missing_header_cells(engine, image_path, lines, retry_context=context)
            table_attempts.extend(cell_attempts)
        except Exception:
            pass  # Optional crops cannot discard a successful page OCR.
        # Reserve the first attempts for explicit missing/malformed cells so
        # check-only row retries cannot exhaust the shared page budget first.
        lines, row_attempts = retry_suspicious_table_rows(engine, image_path, lines, retry_context=context)
        table_attempts.extend(row_attempts)
        if enhance_tables:
            lines = enhance_page_lines(image_path, lines)
        lines = annotate_retry_budget(lines,budget)
        if not table_attempts and not (budget['rowCandidates'] or budget['cellCandidates']):
            return lines, engine_elapsed
        return lines, {
            "source": "primary_plus_table_retry",
            "primary": engine_elapsed,
            "tableRetries": table_attempts,
            "tableRetryBudget": budget,
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
    if detect_input_format(input_path) != "pdf":
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
                    if page.rotation % 360:
                        # get_text boxes are unrotated; page.rect and pixmaps already
                        # include the PDF /Rotate entry. Apply that transform first.
                        box = list(fitz.Rect(box) * page.rotation_matrix)
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
        image_regions = uncovered_pdf_image_regions(blocks,float(page.cropbox.width),float(page.cropbox.height))
        del embedded, blocks
        if not should_ocr_pdf_page(embedded_lines, image_coverage):
            from table_structure import enhance
            pdf_text_count = len(embedded_lines)
            context = PageRetryContext()
            budget = context.budget
            budget.update(imageCandidates=len(image_regions),imageRemaining=len(image_regions))
            if image_regions:
                from PIL import Image
                with tempfile.TemporaryDirectory(prefix='health-pdf-image-') as temp_name:
                    for n,box in enumerate(image_regions[:3]):
                        try:
                            # get_pixmap clips in the visible, intrinsically rotated page.
                            clip = fitz.Rect(box) * page.rotation_matrix
                            render_scale = pdf_render_scale()
                            pixmap = pdf_operation(lambda:page.get_pixmap(matrix=fitz.Matrix(render_scale,render_scale),clip=clip,alpha=False))
                            if pixmap.width < 1 or pixmap.height < 1:
                                continue
                            if not context.reserve(int(pixmap.width*pixmap.height)):
                                del pixmap
                                continue
                            budget['imageRetried'] += 1
                            budget['imageRemaining'] -= 1
                            budget['imageUnresolved'] += 1
                            actual_box = [pixmap.x/render_scale,pixmap.y/render_scale,
                                          (pixmap.x+pixmap.width)/render_scale,(pixmap.y+pixmap.height)/render_scale]
                            target_box = rotate_point_box(actual_box,rotation,base_width,base_height)
                            image_path = Path(temp_name)/f'region-{n}.png'
                            with Image.frombytes('RGB',(pixmap.width,pixmap.height),pixmap.samples) as image:
                                with image.rotate(-rotation,expand=True) as rotated:
                                    rotated.save(image_path)
                            del pixmap
                            region_lines,region_elapsed = recognize_image(engine,image_path,image_role,enhance_tables=False,retry_context=context)
                            region_lines = [{key:value for key,value in line.items() if key != 'tableRetryBudget'} for line in region_lines]
                            region_lines = transform_retry_lines(region_lines,tuple(target_box),render_scale,'pdf_image_region')
                        except Exception:
                            # Retain valid text and expose the unread region in the budget.
                            continue
                        embedded_lines = merge_pdf_text_and_ocr_lines(embedded_lines,region_lines)
                        if region_lines:
                            budget['imageUnresolved'] -= 1
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
            embedded_lines = annotate_retry_budget(embedded_lines,budget)
            return embedded_lines, {
                "source": "pdf_text_plus_regions" if image_regions else "pdf_text",
                "page": index + 1,
                "pdfTextLines": pdf_text_count,
                "hasImageBlocks": has_image_blocks,
                "imageCoverage": round(image_coverage, 4),
                "tableRetryBudget": budget,
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
                lines = annotate_retry_budget(lines,elapsed.get('tableRetryBudget') if isinstance(elapsed,dict) else None)
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

    if detect_input_format(input_path) == "pdf":
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
            input_format = validate_input_format(image_path, action, request.get("mimeType"))

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
                if input_format == "pdf":
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
