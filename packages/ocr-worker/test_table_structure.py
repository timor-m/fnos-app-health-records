import unittest
from unittest.mock import patch
from pathlib import Path
import tempfile
import json
from table_structure import assign_cells, enhance, REVISION


class StructureTests(unittest.TestCase):
    def test_clipped_box_requires_unique_center_and_separation(self):
        boxes = [[0,0,100,20],[110,0,210,20]]
        logic = [[0,0,0,0],[0,0,1,1]]
        self.assertIn("a", assign_cells([{"id":"a","box":[0,0,100,30]}],boxes,logic,"table_0"))
        polygons = [[b[0],b[1],b[2],b[1],b[2],b[3],b[0],b[3]] for b in boxes]
        self.assertIn("a", assign_cells([{"id":"a","box":[0,0,100,30]}],polygons,logic,"table_0"))
        self.assertEqual(assign_cells([{"id":"a","box":[50,0,160,20]}],boxes,logic,"table_0"), {})

    def test_empty_cells_are_not_text(self):
        boxes = [[0,0,100,30], [100,0,200,30], [200,0,300,30]]
        result = assign_cells([{"id":"a", "box":[5,5,90,25]}, {"id":"b", "box":[205,5,290,25]}],
                              boxes, [[0,0,0,0],[0,0,1,1],[0,0,2,2]], "table_0")
        self.assertEqual(result["b"]["column"], 2)
        self.assertEqual(result["a"]["columns"], 3)
        self.assertNotIn("text", result["a"])

    def test_ambiguous_geometry_and_merged_cells_fall_back(self):
        lines = [{"id":"a", "box":[0,0,100,20]}]
        self.assertEqual(assign_cells(lines, [[0,0,100,20]], [[0,0,0,1]], "table_0"), {})
        self.assertEqual(assign_cells(lines, [[0,0,50,20],[50,0,100,20]], [[0,0,0,0],[0,0,1,1]], "table_0"), {})

    def test_missing_or_failed_runtime_preserves_original(self):
        lines = [{"id":"a", "text":"synthetic", "box":[0,0,20,20]}]
        with tempfile.TemporaryDirectory() as root, patch.dict("os.environ", {"STORAGE_DIR": root}):
            result = enhance("unused", lines)
            self.assertEqual(result[0]["text"], lines[0]["text"])
            self.assertEqual(result[0]["tableDiagnostics"]["status"], "unavailable")
            folder = Path(root)/"ocr-table"
            folder.mkdir()
            (folder/"active.json").write_text(json.dumps({"revision":REVISION,"directory":"runtime-test"}))
            with patch("table_structure.subprocess.run", side_effect=TimeoutError):
                result = enhance("unused", lines)
                self.assertEqual(result[0]["text"], lines[0]["text"])
                self.assertEqual(result[0]["tableDiagnostics"]["status"], "failed")

    def test_merged_title_and_unmatched_footer_do_not_discard_regular_rows(self):
        boxes = [[0,0,200,20], [0,20,100,40], [100,20,200,40]]
        logic = [[0,0,0,1], [1,1,0,0], [1,1,1,1]]
        lines = [{"id":"title","box":[5,2,195,18]}, {"id":"name","box":[5,22,95,38]},
                 {"id":"value","box":[105,22,195,38]}, {"id":"footer","box":[5,60,195,80]}]
        self.assertEqual(set(assign_cells(lines, boxes, logic, "table_0")), {"name", "value"})

    def test_ambiguous_text_discards_only_its_row(self):
        boxes = [[0,0,100,20],[100,0,200,20],[0,30,100,50],[100,30,200,50]]
        logic = [[0,0,0,0],[0,0,1,1],[1,1,0,0],[1,1,1,1]]
        lines = [{"id":"bad","box":[50,2,150,18]}, {"id":"good","box":[5,32,95,48]}]
        self.assertEqual(set(assign_cells(lines, boxes, logic, "table_0")), {"good"})


    def test_failed_upgrade_preserves_active_environment(self):
        import install_table_runtime
        with tempfile.TemporaryDirectory() as root, patch.dict("os.environ", {"STORAGE_DIR": root}):
            folder = Path(root)/"ocr-table"
            folder.mkdir()
            old = '{"revision":"old","directory":"runtime-old"}'
            (folder/"active.json").write_text(old)
            with patch("install_table_runtime.subprocess.run", side_effect=RuntimeError("synthetic failure")):
                with self.assertRaises(RuntimeError): install_table_runtime.install()
            self.assertEqual((folder/"active.json").read_text(), old)
            self.assertFalse((folder/".install-lock").exists())


if __name__ == "__main__": unittest.main()
