"""Optional, isolated table inference. Model output supplies geometry, never text."""
from __future__ import annotations
import contextlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

REVISION = "rapid-table-3.0.2-layout-1.2.1-v1"


def rect(box):
    if box and isinstance(box[0], (list, tuple)):
        box = [v for point in box for v in point[:2]]
    if not box or len(box) not in (4, 8) or not all(math.isfinite(float(v)) for v in box):
        raise ValueError("invalid geometry")
    if len(box) == 4:
        return list(map(float, box))
    return [min(box[::2]), min(box[1::2]), max(box[::2]), max(box[1::2])]


def assign_cells(lines, boxes, logic, table_id):
    """Keep complete, unambiguous rows; a bad row must not discard the table."""
    if len(boxes) != len(logic) or not 1 <= len(boxes) <= 4096:
        return {}
    columns = max(int(p[3]) for p in logic) + 1
    if not 2 <= columns <= 64:
        return {}
    occupied = set()
    unsafe_rows = set()
    row_bounds = {}
    for point in logic:
        r, re, c, ce = map(int, point)
        if min(r, c) < 0 or re < r or ce < c or re > 1024 or ce >= columns:
            return {}
        if r != re or c != ce:
            unsafe_rows.update(range(r, re + 1))
        for row in range(r, re + 1):
            for column in range(c, ce + 1):
                if (row, column) in occupied:
                    unsafe_rows.add(row)
                occupied.add((row, column))
    for box, point in zip(boxes, logic):
        _, top, _, bottom = rect(box)
        for row in range(int(point[0]), int(point[1]) + 1):
            old = row_bounds.get(row, (top, bottom))
            row_bounds[row] = (min(old[0], top), max(old[1], bottom))
    for row in row_bounds:
        if any((row, column) not in occupied for column in range(columns)):
            unsafe_rows.add(row)
    assigned = {}
    for line in lines:
        x1, y1, x2, y2 = rect(line["box"])
        area = max(1, (x2-x1)*(y2-y1))
        hits = []
        scores = []
        for i, box in enumerate(boxes):
            a,b,c,d = rect(box)
            overlap = max(0,min(x2,c)-max(x1,a))*max(0,min(y2,d)-max(y1,b))/area
            scores.append(overlap)
            if overlap >= .8:
                hits.append(i)
        if not hits:
            # Slightly clipped detector boxes may still have an unambiguous centre.
            # Require majority coverage, one containing centre, and a clear margin
            # over the next cell; never choose solely by nearest distance.
            ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
            best = ranked[0]
            next_score = scores[ranked[1]] if len(ranked) > 1 else 0
            cx, cy = (x1+x2)/2, (y1+y2)/2
            centres = [i for i, box in enumerate(map(rect, boxes))
                       if box[0] <= cx <= box[2] and box[1] <= cy <= box[3]]
            if centres == [best] and scores[best] >= .6 and scores[best]-next_score >= .2:
                hits = [best]
        if len(hits) != 1:
            # Any unassigned text crossing a row prevents partial acceptance of it.
            for row, (top, bottom) in row_bounds.items():
                if min(y2, bottom) > max(y1, top):
                    unsafe_rows.add(row)
            continue
        p = logic[hits[0]]
        assigned[line["id"]] = {"table": table_id, "row": int(p[0]), "column": int(p[2]), "columns": columns}
    return {key: cell for key, cell in assigned.items() if cell["row"] not in unsafe_rows}


def infer(image_path, lines, installing=False):
    import numpy as np
    from rapid_layout import RapidLayout
    from rapid_table import RapidTable, RapidTableInput
    import rapid_layout
    import rapid_table
    layout_model = Path(rapid_layout.__file__).parent / "models/layout_table.onnx"
    table_model = Path(rapid_table.__file__).parent / "models/slanet-plus.onnx"
    if not installing and (not layout_model.is_file() or not table_model.is_file()):
        raise RuntimeError("models unavailable")
    layout = RapidLayout(model_type="pp_layout_table", **({"model_dir_or_path": str(layout_model)} if layout_model.is_file() else {}))
    table = RapidTable(RapidTableInput(use_ocr=False, model_dir_or_path=str(table_model) if table_model.is_file() else None))
    from PIL import Image
    with Image.open(image_path) as image:
        rgb = image.convert("RGB")
        # RapidAI ndarray inputs use BGR.
        img = np.asarray(rgb)[:, :, ::-1].copy()
        rgb.close()
    regions = layout(img)
    output = {}
    for i, (box, label, score) in enumerate(zip(regions.boxes, regions.class_names, regions.scores)):
        if i >= 16:
            break
        if "table" not in str(label).lower() or float(score) < .6:
            continue
        x1,y1,x2,y2 = map(int, box)
        x1,y1 = max(0,x1),max(0,y1)
        x2,y2 = min(img.shape[1],x2),min(img.shape[0],y2)
        if x2 <= x1 or y2 <= y1:
            continue
        selected = []
        for line in lines:
            try:
                a,b,c,d = rect(line.get("box"))
            except (ValueError, TypeError):
                continue
            if x1 <= (a+c)/2 <= x2 and y1 <= (b+d)/2 <= y2:
                selected.append({"id": line["id"], "box": [a-x1,b-y1,c-x1,d-y1]})
        if not selected:
            continue
        try:
            result = table(img[y1:y2,x1:x2].copy())
            mapping = assign_cells(selected, result.cell_bboxes[0].tolist(), result.logic_points[0].tolist(), f"table_{i}")
            # Overlap invalidates only affected tables, not unrelated page regions.
            conflicts = output.keys() & mapping.keys()
            if conflicts:
                affected = {output[key]["table"] for key in conflicts}
                output = {key: cell for key, cell in output.items() if cell["table"] not in affected}
                continue
            for line in selected:
                output[line["id"]] = mapping.get(line["id"], {"table": f"table_{i}", "unsafe": True})
        except Exception:
            continue
    return output


def enhance(image_path, lines):
    def diagnosed(result, status):
        if not result:
            return result
        diagnostic = {"status": status, "mapped": sum("tableCell" in l for l in result),
                      "unsafe": sum(bool(l.get("tableUnsafe")) for l in result)}
        return [{**result[0], "tableDiagnostics": diagnostic}, *result[1:]]
    if os.environ.get("OCR_TABLE_ENHANCEMENT", "auto") == "off":
        return diagnosed(lines, "disabled")
    root = Path(os.environ.get("STORAGE_DIR", ".data")) / "ocr-table"
    try:
        active = json.loads((root / "active.json").read_text())
        if active.get("revision") != REVISION:
            return diagnosed(lines, "unavailable")
        runtime = (root / active["directory"]).resolve()
        if runtime.parent != root.resolve():
            return diagnosed(lines, "unavailable")
        child = subprocess.run([str(runtime / "bin/python"), str(Path(__file__).resolve()), str(image_path)],
            input=json.dumps([{"id": l["id"], "box": l.get("box")} for l in lines]),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90,
            env={**os.environ, "OMP_NUM_THREADS": "1"}, check=True)
        mapping = json.loads(child.stdout)
        result = [{**l, **({"tableUnsafe": True} if mapping.get(l["id"], {}).get("unsafe")
                        else {"tableCell": mapping[l["id"]]} if l["id"] in mapping else {})} for l in lines]
        accepted = any("tableCell" in line for line in result)
        rejected = any(line.get("tableUnsafe") for line in result)
        return diagnosed(result, ("partial" if rejected else "applied") if accepted else "no_structure")
    except FileNotFoundError:
        return diagnosed(lines, "unavailable")
    except Exception:
        return diagnosed(lines, "failed")


if __name__ == "__main__":
    # No model diagnostics or report text may enter the NDJSON protocol or logs.
    with contextlib.redirect_stdout(sys.stderr):
        if sys.argv[1] == "--check":
            import tempfile
            from PIL import Image, ImageDraw
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "check.png"
                img = Image.new("RGB", (480, 200), "white")
                draw = ImageDraw.Draw(img)
                for x in (10,160,310,470): draw.line((x,10,x,190), fill="black", width=2)
                for y in (10,70,130,190): draw.line((10,y,470,y), fill="black", width=2)
                img.save(path)
                # Exercise both models even if layout does not classify the synthetic grid.
                infer(path, [], installing=True)
                from rapid_table import RapidTable, RapidTableInput
                result = RapidTable(RapidTableInput(use_ocr=False))(str(path))
                if not len(result.cell_bboxes) or not len(result.logic_points):
                    raise RuntimeError("table self-test failed")
            payload = {"revision": REVISION}
        else:
            payload = infer(sys.argv[1], json.load(sys.stdin))
    print(json.dumps(payload))
