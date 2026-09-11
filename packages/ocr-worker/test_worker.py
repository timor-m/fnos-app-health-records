import importlib.util
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "health_records_ocr_worker", Path(__file__).with_name("worker.py")
)
worker = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(worker)


def ocr_line(text, confidence, x1, y1, x2, y2, variant=None):
    line = {
        "text": text,
        "confidence": confidence,
        "box": [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
    }
    if variant:
        line["variant"] = variant
    return line


class TableRetryTest(unittest.TestCase):
    def test_pdf_fusion_keeps_repeated_results_units_and_signs_at_distinct_positions(self):
        source = [ocr_line(text, 1, 10, index * 30, 50, index * 30 + 20)
                  for index, text in enumerate(["0", "0", "-", "-", "U/L", "U/L", "+", "±"])]
        duplicates = [{**line, "confidence": .9} for line in source]
        fused = worker.merge_pdf_text_and_ocr_lines(source, duplicates)
        self.assertEqual([line["text"] for line in fused], [line["text"] for line in source])
        self.assertEqual(len(set(line["id"] for line in fused)), len(source))

    def test_pdf_fusion_keeps_unknown_position_and_conflicting_text(self):
        pdf = [ocr_line("0", 1, 0, 0, 20, 20)]
        ocr = [ocr_line("8", .9, 0, 0, 20, 20), {"text":"0", "confidence":.9}]
        self.assertEqual(len(worker.merge_pdf_text_and_ocr_lines(pdf, ocr)), 3)

    def test_structure_annotations_return_to_original_pdf_coordinates(self):
        from unittest.mock import patch
        source = [{"id":"a", "text":"synthetic", "box":[10,20,30,40]}]
        def annotate(path, lines):
            self.assertEqual(lines[0]["box"], [30,60,90,120])
            return [{**lines[0], "tableCell":{"table":"table_0", "row":0, "column":0, "columns":2}}]
        with patch("table_structure.enhance", side_effect=annotate):
            result = worker.enhance_page_lines(Path("unused"), source, 3)
        self.assertEqual(result[0]["box"], source[0]["box"])
        self.assertIn("tableCell", result[0])
        self.assertNotIn("tableCell", source[0])

    def test_auto_backend_prefers_onnxruntime_on_arm64(self):
        self.assertEqual(
            worker.backend_candidates(machine="aarch64"),
            ["onnxruntime", "openvino"],
        )
        self.assertEqual(
            worker.backend_candidates(machine="x86_64"),
            ["openvino", "onnxruntime"],
        )

    def test_explicit_backend_is_not_overridden_by_architecture(self):
        self.assertEqual(
            worker.backend_candidates("openvino", "aarch64"),
            ["openvino"],
        )

    def test_detects_missing_and_corrupted_double_column_results(self):
        lines = [
            ocr_line("白细胞数(WBC)", 0.97, 80, 60, 260, 90),
            ocr_line("5.0", 0.99, 520, 60, 570, 90),
            ocr_line("3.5-9.5", 0.99, 720, 60, 810, 90),
            ocr_line("中性粒细胞百分比(NEUT%)", 0.95, 80, 100, 390, 130),
            ocr_line("40-75", 0.99, 720, 100, 805, 130),
            ocr_line("血小板体积分布宽度(PDW)", 0.95, 870, 100, 1160, 130),
            ocr_line("↑76", 0.82, 1300, 100, 1360, 130),
            ocr_line("9.8-15.2", 0.99, 1500, 100, 1600, 130),
            ocr_line("平均血小板体积(MPV)", 0.96, 870, 140, 1120, 170),
            ocr_line("9.1", 0.99, 1300, 140, 1360, 170),
            ocr_line("9.1-12.0", 0.99, 1500, 140, 1600, 170),
        ]

        rows = worker.suspicious_table_rows(lines, 1737, 1227)

        self.assertEqual(
            [row["name"]["text"] for row in rows],
            ["中性粒细胞百分比(NEUT%)", "血小板体积分布宽度(PDW)"],
        )
        self.assertIsNone(rows[0]["result"])
        self.assertEqual(rows[1]["result"]["text"], "↑76")

    def test_combines_retry_marker_with_same_variant_only(self):
        lines = [
            ocr_line("9.2", 0.99, 100, 10, 150, 40, "gray"),
            ocr_line("↓", 0.80, 145, 10, 170, 40, "gray"),
            ocr_line("↑", 0.95, 145, 10, 170, 40, "red"),
        ]

        combined = worker.combine_retry_result_markers(lines)

        self.assertIn("9.2↓", [line["text"] for line in combined])
        self.assertNotIn("9.2↑", [line["text"] for line in combined])

    def test_complete_decimal_scores_above_truncated_candidate(self):
        reference = (40.0, 75.0)
        truncated = ocr_line("39", 0.99, 10, 10, 40, 40)
        complete = ocr_line("39.3", 0.90, 10, 10, 50, 40)

        self.assertGreater(
            worker.retry_result_score(complete, reference),
            worker.retry_result_score(truncated, reference),
        )


if __name__ == "__main__":
    unittest.main()
