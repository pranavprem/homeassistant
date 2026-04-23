#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ENV = ROOT_DIR / ".env"
DEFAULT_BUNDLE = ROOT_DIR / "migrations" / "grocy" / "2026-04-21-homebutler.json"


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = raw_line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def resolve_base_url(env_values: dict[str, str], explicit: str | None) -> str:
    if explicit:
        return explicit.rstrip("/")
    port = env_values.get("HOMEBUTLER_PORT") or os.environ.get("HOMEBUTLER_PORT") or "8000"
    return f"http://127.0.0.1:{port}".rstrip("/")


def extract_error_detail(payload: bytes) -> str:
    if not payload:
        return ""
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError:
        return payload.decode("utf-8", errors="replace")
    if isinstance(parsed, dict):
        detail = parsed.get("detail")
        if isinstance(detail, dict):
            return json.dumps(detail, indent=2, sort_keys=True)
        if detail:
            return str(detail)
    return json.dumps(parsed, indent=2, sort_keys=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply the checked-in Grocy migration bundle through HomeButler")
    parser.add_argument("--env-file", default=str(DEFAULT_ENV), help="Path to .env file")
    parser.add_argument("--bundle", default=str(DEFAULT_BUNDLE), help="Path to migration bundle JSON")
    parser.add_argument("--base-url", help="Override HomeButler base URL, defaults to http://127.0.0.1:${HOMEBUTLER_PORT}")
    parser.add_argument("--timeout", type=int, default=120, help="HTTP timeout in seconds")
    args = parser.parse_args()

    env_values = parse_env_file(Path(args.env_file))
    bundle_path = Path(args.bundle)
    if not bundle_path.exists():
        raise SystemExit(f"Bundle not found: {bundle_path}")

    payload = bundle_path.read_bytes()
    base_url = resolve_base_url(env_values, args.base_url)
    url = f"{base_url}/migration/grocy/apply"

    request = Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )

    try:
        with urlopen(request, timeout=args.timeout) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = extract_error_detail(exc.read())
        print(f"HTTP {exc.code} from {url}", file=sys.stderr)
        if detail:
            print(detail, file=sys.stderr)
        return 1
    except URLError as exc:
        print(f"Could not reach HomeButler at {url}: {exc.reason}", file=sys.stderr)
        return 1

    try:
        parsed = json.loads(body)
        print(json.dumps(parsed, indent=2, sort_keys=True))
    except json.JSONDecodeError:
        print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
