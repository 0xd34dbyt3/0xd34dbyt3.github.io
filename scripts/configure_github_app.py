"""Prompt for an App credential pair and send ONE secret over Wrangler stdin.

No credential files, shell interpolation, command-line secret arguments or logging.
Production always creates an UNDEPLOYED version; promotion remains a separate step.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from build_worker_admin import build as build_worker_assets

ROOT = Path(__file__).resolve().parents[1]


def credential_bundle(client_id, client_secret):
    if not re.fullmatch(r"Iv[A-Za-z0-9]+", client_id) or not client_secret or re.search(r"\s", client_secret):
        raise ValueError("GitHub App Client ID/secret biçimi geçersiz; değerler gösterilmedi.")
    return json.dumps({"client_id": client_id, "client_secret": client_secret}, separators=(",", ":"))


def wrangler_command():
    installed = shutil.which("wrangler")
    if installed:
        return [installed]
    # Use the already-installed cache; never install a new tool through npx.
    node = shutil.which("node")
    cached = sorted(Path.home().glob(".npm/_npx/*/node_modules/wrangler/bin/wrangler.js"))
    if node and cached:
        return [node, str(cached[-1])]
    raise ValueError("Mevcut Wrangler bulunamadı; yeni araç kurulmadı.")


def secret_command(target, command):
    if target == "check":
        return command + ["secret", "put", "GITHUB_APP_CREDENTIALS", "--env", "appcheck"]
    if target == "production":
        return command + ["versions", "secret", "put", "GITHUB_APP_CREDENTIALS",
                          "--message", "GitHub App credential pair staged atomically"]
    raise ValueError("Bilinmeyen hedef")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=["check", "production"], required=True)
    parser.add_argument("--confirmed-real-app-test", action="store_true",
                        help="Gerçek App ile giriş, kayıt, PNG ve yeniden giriş/taslak testinin sahibi tarafından onayı")
    args = parser.parse_args()
    if args.target == "production" and not args.confirmed_real_app_test:
        parser.error("Önce gerçek App testi gerekir; simüle testler yeterli değildir.")
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        parser.error("Maskeli giriş için etkileşimli terminal gerekir; pipe/CI girdisi kabul edilmez.")
    try:
        command = secret_command(args.target, wrangler_command())
        print("Hedef: " + ("izole appcheck Worker" if args.target == "check" else "üretim için YAYIMLANMAYAN Worker sürümü"))
        client_id = getpass.getpass("GitHub App Client ID (gizli giriş): ")
        secret = getpass.getpass("GitHub App client secret (gizli giriş): ")
        bundle = credential_bundle(client_id, secret)
        environment = dict(os.environ, WRANGLER_SEND_METRICS="false")
        # Matching code/assets must exist before either target receives the pair.
        # Only the isolated check Worker is deployed here; production is staged.
        with tempfile.TemporaryDirectory(prefix="portfolio-app-release-") as output:
            assets = Path(output) / "admin"
            build_worker_assets(assets)
            upload = (["versions", "upload"] if args.target == "production"
                      else ["deploy", "--env", "appcheck"])
            uploaded = subprocess.run(wrangler_command() + upload + ["--assets", str(assets),
                                      "--message", "GitHub App preparation"],
                                     text=True, capture_output=True, cwd=ROOT, env=environment, timeout=120)
            if uploaded.returncode:
                raise ValueError("Kod/asset sürümü yüklenemedi; üretim ve credential'lar değiştirilmedi.")
        result = subprocess.run(command, input=bundle, text=True, capture_output=True,
                                cwd=ROOT, env=environment, timeout=120)
        if result.returncode:
            raise ValueError("Wrangler secret işlemi başarısız (çıkış " + str(result.returncode) +
                             "); credential/ham araç çıktısı gösterilmedi. Önce wrangler whoami ile erişimi kontrol edin.")
        print("Client ID ve secret tek GITHUB_APP_CREDENTIALS kaydıyla birlikte işlendi.")
        if args.target == "production":
            ids = re.findall(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", result.stdout)
            if ids:
                print("Yayımlanmayan sürüm: " + ids[-1])
                print("Bu sürümü seçip %100 deploy etmeden mevcut üretim OAuth'u değişmez.")
            else:
                print("Sürüm ID'sini wrangler versions list ile bulun; hiçbir sürüm otomatik deploy edilmedi.")
    except (ValueError, OSError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        if isinstance(error, ValueError):
            print(str(error), file=sys.stderr)
        else:
            print("İşlem tamamlanamadı; sırlar gösterilmedi. Ağ hatasında sürüm/secret durumunu salt okunur kontrol edin.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
