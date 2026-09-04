#!/usr/bin/env python3
"""Render a least-privilege, DGX-free Hermes data directory for Linux."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
from pathlib import Path

import yaml

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_PRIMARY_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"
OPENROUTER_FALLBACK_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
DISABLED_MACOS_JOBS = {
    "office_pulse_push.py": "Requires the macOS Mail/Dropbox data sources",
    "sent_mail_tracker.py": "Requires the macOS Apple Mail store",
}
COPY_DIRECTORIES = (
    "assets",
    "kanban",
    "kanban-workspaces",
    "knowledge",
    "memories",
    "myinvest-prompts",
    "plugins",
    "scripts",
    "skills",
    "work",
)
COPY_FILES = (
    "brief_assistent_soul.md",
    "channel_directory.json",
    "HERMES_POWER.md",
    "SOUL.md",
)
PROFILE_DIRECTORIES = ("memories", "plugins", "skills")
PROFILE_FILES = ("profile.yaml", "SOUL.md")
DASHBOARD_AUTH_ENV_KEYS = {
    "username": "HERMES_DASHBOARD_BASIC_AUTH_USERNAME",
    "password_hash": "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH",
    "secret": "HERMES_DASHBOARD_BASIC_AUTH_SECRET",
}


def clear_copied_flags(root: Path) -> None:
    if not hasattr(os, "chflags") or not root.exists():
        return
    for current, directories, files in os.walk(root, topdown=False):
        for name in files + directories:
            try:
                os.chflags(Path(current) / name, 0, follow_symlinks=False)
            except OSError:
                pass
        try:
            os.chflags(current, 0)
        except OSError:
            pass


def copy_tree(source: Path, destination: Path) -> None:
    if not source.exists():
        return
    shutil.copytree(
        source,
        destination,
        dirs_exist_ok=True,
        symlinks=False,
        ignore_dangling_symlinks=True,
        ignore=shutil.ignore_patterns(
            ".DS_Store",
            ".git",
            ".venv",
            "__pycache__",
            "node_modules",
            "*.log",
        ),
    )
    clear_copied_flags(destination)


def patch_config(config: dict) -> dict:
    model = config.setdefault("model", {})
    model["provider"] = "openrouter"
    model["default"] = OPENROUTER_PRIMARY_MODEL
    model["base_url"] = OPENROUTER_BASE_URL
    model["api_mode"] = "chat_completions"
    config["fallback_providers"] = [
        {
            "provider": "openrouter",
            "model": OPENROUTER_FALLBACK_MODEL,
            "base_url": OPENROUTER_BASE_URL,
            "api_mode": "chat_completions",
        }
    ]
    providers = config.get("providers", {})
    config["providers"] = {
        name: entry for name, entry in providers.items() if "dgx" not in name.lower()
    }

    agent = config.setdefault("agent", {})
    agent["reasoning_effort"] = "medium"
    if agent.get("persona_prompt_file"):
        agent["persona_prompt_file"] = "/opt/data/brief_assistent_soul.md"

    mcp_servers = config.setdefault("mcp_servers", {})
    mcp_servers.pop("cua-driver", None)
    mcp_servers.pop("dgx-memory", None)
    mcp_servers["memory-bridge"] = {
        "command": "node",
        "args": ["/opt/memory-mcp/proxy/memory-proxy.mjs"],
        "env": {
            "MEMORY_HTTP_URL": "http://memory:8787",
            "MEMORY_HTTP_TOKEN_FILE": "/run/secrets/memory_http_token",
        },
    }
    return config


def render_yaml(source: Path, destination: Path) -> None:
    config = yaml.safe_load(source.read_text(encoding="utf-8")) or {}
    patched = patch_config(config)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        yaml.safe_dump(patched, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )
    destination.chmod(0o600)


def load_dashboard_auth(source: Path | None) -> dict[str, str]:
    if source is None:
        return {}
    payload = json.loads(source.read_text(encoding="utf-8"))
    values: dict[str, str] = {}
    for field, env_key in DASHBOARD_AUTH_ENV_KEYS.items():
        value = payload.get(field)
        if not isinstance(value, str) or not value or any(char in value for char in "\r\n'"):
            raise ValueError(f"invalid dashboard credential field: {field}")
        values[env_key] = value
    if not values["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH"].startswith("scrypt$"):
        raise ValueError("dashboard password_hash must use scrypt")
    if len(values["HERMES_DASHBOARD_BASIC_AUTH_SECRET"]) < 32:
        raise ValueError("dashboard secret must contain at least 32 characters")
    return values


def render_env(
    source: Path, destination: Path, extra: dict[str, str] | None = None
) -> None:
    extra = extra or {}
    kept: list[str] = []
    for raw in source.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if stripped.startswith("#") and "SUDO_PASSWORD" in stripped:
            continue
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key == "SUDO_PASSWORD" or key in extra:
                continue
        kept.append(raw)
    kept.extend(f"{key}='{value}'" for key, value in extra.items())
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(kept).rstrip() + "\n", encoding="utf-8")
    destination.chmod(0o600)


def render_cron(source: Path, destination: Path) -> None:
    payload = json.loads(source.read_text(encoding="utf-8"))
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    for job in payload.get("jobs", []):
        reason = DISABLED_MACOS_JOBS.get(str(job.get("script", "")))
        if reason and job.get("enabled"):
            job["enabled"] = False
            job["state"] = "paused"
            job["paused_at"] = now
            job["paused_reason"] = reason
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    destination.chmod(0o600)


def render(
    source: Path, destination: Path, dashboard_credentials: Path | None = None
) -> None:
    if destination.exists():
        clear_copied_flags(destination)
        shutil.rmtree(destination)
    destination.mkdir(parents=True, mode=0o700)

    render_yaml(source / "config.yaml", destination / "config.yaml")
    render_env(
        source / ".env",
        destination / ".env",
        load_dashboard_auth(dashboard_credentials),
    )

    for name in COPY_FILES:
        item = source / name
        if item.is_file():
            shutil.copy2(item, destination / name)
    for name in COPY_DIRECTORIES:
        copy_tree(source / name, destination / name)

    jobs = source / "cron" / "jobs.json"
    if jobs.is_file():
        render_cron(jobs, destination / "cron" / "jobs.json")
    stripe_state = source / "state" / "stripe_seen.json"
    if stripe_state.is_file():
        (destination / "state").mkdir(parents=True, exist_ok=True)
        shutil.copy2(stripe_state, destination / "state" / stripe_state.name)

    profiles_destination = destination / "profiles"
    for profile in sorted((source / "profiles").iterdir()):
        if not profile.is_dir():
            continue
        target = profiles_destination / profile.name
        render_yaml(profile / "config.yaml", target / "config.yaml")
        if (profile / ".env").is_file():
            render_env(profile / ".env", target / ".env")
        for name in PROFILE_FILES:
            item = profile / name
            if item.is_file():
                target.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, target / name)
        for name in PROFILE_DIRECTORIES:
            copy_tree(profile / name, target / name)

    (destination / ".hermes").symlink_to(".")
    claude = destination / ".claude"
    claude.mkdir()
    (claude / "memory-mcp").symlink_to("/opt/memory-mcp")
    os.chmod(destination, 0o700)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dashboard-credentials", type=Path)
    args = parser.parse_args()
    credentials = (
        args.dashboard_credentials.expanduser().resolve()
        if args.dashboard_credentials
        else None
    )
    render(
        args.source.expanduser().resolve(),
        args.output.expanduser().resolve(),
        credentials,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
