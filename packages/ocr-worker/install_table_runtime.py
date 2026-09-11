"""Build an immutable enhancement environment, then atomically publish its pointer."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import hashlib
from table_structure import REVISION


def install():
    root = Path(os.environ.get("STORAGE_DIR", ".data")).resolve() / "ocr-table"
    root.mkdir(parents=True, exist_ok=True)
    lock = root / ".install-lock"
    try:
        lock.mkdir()
    except FileExistsError:
        raise RuntimeError("表格环境已有安装任务；若任务意外终止，请确认没有安装进程后移除 .install-lock")
    try:
        script = Path(__file__).with_name("table_structure.py")
        try:
            active = json.loads((root / "active.json").read_text())
            existing = (root / active["directory"]).resolve()
            if active.get("revision") == REVISION and existing.parent == root and (existing / "bin/python").is_file():
                hashes = active.get("modelHashes", {})
                if hashes and all((existing / name).is_file() and hashlib.sha256((existing / name).read_bytes()).hexdigest() == digest for name, digest in hashes.items()):
                    print("表格增强已是当前版本，无需重复安装", flush=True)
                    return
        except (OSError, ValueError, KeyError):
            pass
        runtime = Path(tempfile.mkdtemp(prefix="runtime-", dir=root))
        print("创建独立表格环境，保留旧 OCR 和已启用环境", flush=True)
        subprocess.run([sys.executable, "-m", "venv", str(runtime)], check=True)
        python = str(runtime / "bin/python")
        print("安装表格依赖（下载失败可重新点击升级）", flush=True)
        subprocess.run([python, "-m", "pip", "install", "--retries", "3", "--timeout", "30", "-r",
                        str(Path(__file__).with_name("requirements-table.txt"))], check=True)
        print("下载模型并执行版面、表格推理自检", flush=True)
        subprocess.run([python, str(script), "--check"], check=True, timeout=300)
        model_hashes = {str(path.relative_to(runtime)): hashlib.sha256(path.read_bytes()).hexdigest()
                        for path in runtime.glob("lib/python*/site-packages/rapid_*/models/*.onnx")}
        if len(model_hashes) < 2:
            raise RuntimeError("模型完整性检查失败")
        marker = {"revision": REVISION, "directory": runtime.name, "modelHashes": model_hashes}
        pending = root / "active.pending.json"
        pending.write_text(json.dumps(marker), encoding="utf8")
        os.replace(pending, root / "active.json")
        print("表格增强已启用；原有 OCR 环境保持不变", flush=True)
    finally:
        lock.rmdir()


if __name__ == "__main__":
    install()
