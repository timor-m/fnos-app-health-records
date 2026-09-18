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

    def test_onnx_threads_keep_onnxruntime_default_off_arm(self):
        from unittest.mock import patch

        with patch("platform.machine", return_value="x86_64"):
            self.assertEqual(worker.onnx_engine_kwargs(), {})

    def test_onnx_threads_leave_one_core_for_the_system_on_arm(self):
        from unittest.mock import patch

        with patch("platform.machine", return_value="aarch64"), patch("os.cpu_count", return_value=4):
            self.assertEqual(
                worker.onnx_engine_kwargs(),
                {"intra_op_num_threads": 3, "inter_op_num_threads": 1},
            )
        with patch("platform.machine", return_value="aarch64"), patch("os.cpu_count", return_value=1):
            self.assertEqual(worker.onnx_engine_kwargs()["intra_op_num_threads"], 1)
        with patch("platform.machine", return_value="aarch64"), patch("os.cpu_count", return_value=16):
            self.assertEqual(worker.onnx_engine_kwargs()["intra_op_num_threads"], 4)

    def test_onnx_threads_environment_override_wins_everywhere(self):
        import os
        from unittest.mock import patch

        with patch.dict(os.environ, {"OCR_WORKER_ONNX_INTRA_OP_THREADS": "2", "OCR_WORKER_ONNX_INTER_OP_THREADS": "2"}):
            self.assertEqual(
                worker.onnx_engine_kwargs(),
                {"intra_op_num_threads": 2, "inter_op_num_threads": 2},
            )
        with patch.dict(os.environ, {"OCR_WORKER_ONNX_INTRA_OP_THREADS": "0"}):
            self.assertEqual(worker.onnx_engine_kwargs(), {})

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

    def test_detects_suspicious_rows_in_parenthesized_wide_layout(self):
        # 括号包裹参考值 + 名称列与参考值列分处两端的宽版式检验单
        lines = [
            ocr_line("★甘油三酯", 0.95, 12, 859, 77, 879),
            ocr_line("1.89(mmolL)↑", 0.83, 352, 859, 454, 879),
            ocr_line("(0.3-1.71)", 0.99, 1099, 860, 1160, 880),
            ocr_line("★白蛋白", 0.97, 12, 900, 77, 920),
            ocr_line("48.3 (g/L)", 0.96, 352, 900, 460, 920),
            ocr_line("(35-50)", 0.99, 1099, 900, 1160, 920),
        ]

        rows = worker.suspicious_table_rows(lines, 1170, 1120)

        self.assertEqual([row["name"]["text"] for row in rows], ["★甘油三酯"])
        self.assertTrue(rows[0]["resultSuspicious"])
        self.assertEqual(rows[0]["result"]["text"], "1.89(mmolL)↑")

    def test_restores_inline_unit_from_retry_lines(self):
        retry_lines = [ocr_line("mmol/L", 0.84, 360, 859, 450, 879, "table_upscale")]

        restored = worker.restore_inline_unit("1.89(mmolL)↑", "1.89↑", retry_lines)

        self.assertEqual(restored, "1.89(mmol/L)↑")

    def test_restores_inline_unit_falls_back_to_original_unit(self):
        restored = worker.restore_inline_unit("1.89(mmolL)↑", "1.89↑", [])

        self.assertEqual(restored, "1.89(mmolL)↑")

    def test_restore_inline_unit_keeps_text_without_unit(self):
        restored = worker.restore_inline_unit("1.89↑", "1.90↑", [])

        self.assertEqual(restored, "1.90↑")

    def test_extreme_value_row_is_marked_check_only_not_corrupt(self):
        # 真实的重症异常（72.0，参考 0.4~8）：超上限 3 倍触发核对，但不是损坏行
        lines = [
            ocr_line("嗜酸性细胞百分数(EOS%)", 0.98, 96, 638, 388, 664),
            ocr_line("72.0", 1.00, 609, 636, 666, 660),
            ocr_line("%", 0.99, 775, 636, 790, 660),
            ocr_line("0.4~8", 0.99, 991, 635, 1040, 660),
        ]

        rows = worker.suspicious_table_rows(lines, 1352, 1920)

        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["resultSuspicious"])
        self.assertTrue(rows[0]["resultExtreme"])
        self.assertFalse(rows[0]["resultCorrupt"])

    def test_extreme_value_retry_replacement_requires_in_range_value(self):
        row = {"reference": (0.4, 8.0), "resultExtreme": True, "resultCorrupt": False}
        # 重读给出反向越界值（72.0→0）：拒绝替换，保留原始读数
        self.assertFalse(worker.retry_replacement_allowed(row, 0.0))
        self.assertFalse(worker.retry_replacement_allowed(row, None))
        # 重读回落区间内（如 7259→72.59 这类真误读被修正）：允许替换
        self.assertTrue(worker.retry_replacement_allowed(row, 5.2))
        # 损坏形态的行不受限制，维持原替换逻辑
        corrupt = {"reference": (0.4, 8.0), "resultExtreme": True, "resultCorrupt": True}
        self.assertTrue(worker.retry_replacement_allowed(corrupt, 0.0))


if __name__ == "__main__":
    unittest.main()
