"""Create the small, explicit static asset set served by the OAuth Worker admin origin."""
import argparse
import json
import shutil
from pathlib import Path

from cms_config import config as cms_config

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    ROOT / "pages/admin.html": Path("admin/index.html"),
    ROOT / "pages/admin.js": Path("admin/admin.js"),
    ROOT / "public/js/content-tools.js": Path("js/content-tools.js"),
}


def build(output: Path) -> None:
    site = json.loads((ROOT / "site.config.json").read_text(encoding="utf-8"))
    if not site.get("adminEnabled"):
        raise ValueError("Cannot build Worker admin assets while admin is disabled")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Worker asset output must be empty; refusing to overwrite")
    output.mkdir(parents=True, exist_ok=True)
    for source, relative in FILES.items():
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    config_path = output / "admin/config.yml"
    config_path.write_text(json.dumps(cms_config(site), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    expected = {relative.as_posix() for relative in FILES.values()} | {"admin/config.yml"}
    actual = {path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file()}
    if actual != expected:
        raise ValueError("Unexpected Worker admin asset set")
    print(json.dumps({"output": str(output), "files": sorted(actual)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist/worker-admin")
    build(parser.parse_args().output)
