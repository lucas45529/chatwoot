#!/usr/bin/env python3
"""Create and verify a private, portable snapshot of a Hermes data directory."""

from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import errno
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import time
from pathlib import Path, PurePosixPath
from urllib.parse import quote


MANIFEST_NAME = "snapshot-manifest.json"
FORMAT_VERSION = 1
DEFAULT_SQLITE_TIMEOUT = 10.0
MAX_SQLITE_TIMEOUT = 30.0
MAX_MANIFEST_BYTES = 128 * 1024 * 1024
COPY_CHUNK_SIZE = 1024 * 1024
EXCLUDED_DIRECTORIES = {
    ".backup": "backups",
    ".backups": "backups",
    ".cache": "cache",
    ".git": "code-repository-metadata",
    ".hg": "code-repository-metadata",
    ".mypy_cache": "cache",
    ".pytest_cache": "cache",
    ".recovery": "backups",
    ".ruff_cache": "cache",
    ".svn": "code-repository-metadata",
    ".tox": "cache",
    ".venv": "cache",
    "__pycache__": "cache",
    "backup": "backups",
    "backups": "backups",
    "cache": "cache",
    "caches": "cache",
    "log": "logs",
    "logs": "logs",
    "node_modules": "cache",
    "state-snapshots": "backups",
    "venv": "cache",
}
SQLITE_SUFFIXES = (".db", ".sqlite", ".sqlite3")
SQLITE_SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal")
SQLITE_HEADER = b"SQLite format 3\x00"


class SnapshotError(RuntimeError):
    """Raised when a snapshot cannot be created or trusted."""


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _resolved_create_paths(source: Path, output: Path) -> tuple[Path, Path]:
    source_argument = source.expanduser()
    output_argument = output.expanduser()
    if source_argument.is_symlink():
        raise SnapshotError(f"source is a symlink: {source_argument}")
    try:
        source_path = source_argument.resolve(strict=True)
    except FileNotFoundError as error:
        raise SnapshotError(f"source does not exist: {source_argument}") from error
    if not source_path.is_dir():
        raise SnapshotError(f"source is not a directory: {source_path}")
    if os.path.lexists(output_argument):
        raise SnapshotError(f"output already exists: {output_argument}")
    try:
        output_parent = output_argument.parent.resolve(strict=True)
    except FileNotFoundError as error:
        raise SnapshotError(f"output parent does not exist: {output_argument.parent}") from error
    if not output_parent.is_dir():
        raise SnapshotError(f"output parent is not a directory: {output_parent}")
    output_path = output_parent / output_argument.name
    if output_path == source_path:
        raise SnapshotError("source and output are the same path")
    if _is_within(output_path, source_path) or _is_within(source_path, output_path):
        raise SnapshotError(
            f"source and output must not be contained within one another: {source_path} / {output_path}"
        )
    return source_path, output_path


def _validate_timeout(timeout: float) -> float:
    if timeout <= 0 or timeout > MAX_SQLITE_TIMEOUT:
        raise SnapshotError(
            f"SQLite timeout must be greater than zero and at most {MAX_SQLITE_TIMEOUT:g} seconds"
        )
    return timeout


def _relative_path(path: Path, root: Path) -> str:
    relative = path.relative_to(root).as_posix()
    if "\\" in relative:
        raise SnapshotError(f"path is not portable: {relative!r}")
    return relative


def _directory_is_repository(path: Path) -> bool:
    return any(os.path.lexists(path / marker) for marker in (".git", ".hg", ".svn"))


def _directory_exclusion_reason(name: str) -> str | None:
    lower = name.lower()
    reason = EXCLUDED_DIRECTORIES.get(lower)
    if reason:
        return reason
    if lower.endswith(("-venv", "_venv", "-cache", "_cache")):
        return "cache"
    return None


def _file_exclusion_reason(name: str) -> str | None:
    lower = name.lower()
    if lower == MANIFEST_NAME:
        return "generated-manifest"
    if lower == ".ds_store":
        return "cache"
    if lower.endswith(SQLITE_SIDECAR_SUFFIXES):
        return "sqlite-sidecar"
    if lower.endswith((".log", ".pyc", ".pyo", ".swp", "~")):
        return "cache-or-log"
    return None


def _inventory(source: Path) -> tuple[list[dict[str, object]], list[str], list[dict[str, str]]]:
    files: list[dict[str, object]] = []
    directories: list[str] = []
    exclusions: list[dict[str, str]] = []

    def visit(directory: Path) -> None:
        try:
            with os.scandir(directory) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name)
        except OSError as error:
            relative_directory = _relative_path(directory, source) or "."
            raise SnapshotError(
                f"cannot scan source directory {relative_directory}: {error}"
            ) from error
        for entry in entries:
            path = Path(entry.path)
            relative = _relative_path(path, source)
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError as error:
                raise SnapshotError(f"cannot inspect source path {relative}: {error}") from error
            if stat.S_ISLNK(metadata.st_mode):
                exclusions.append(
                    {"path": relative, "kind": "symlink", "reason": "symlink-not-followed"}
                )
                continue
            if stat.S_ISDIR(metadata.st_mode):
                reason = _directory_exclusion_reason(entry.name)
                if reason is None and _directory_is_repository(path):
                    reason = "code-repository"
                if reason:
                    exclusions.append({"path": relative, "kind": "directory", "reason": reason})
                    continue
                directories.append(relative)
                visit(path)
                continue
            if not stat.S_ISREG(metadata.st_mode):
                raise SnapshotError(f"source path {relative} has unsupported file type")
            reason = _file_exclusion_reason(entry.name)
            if reason:
                exclusions.append({"path": relative, "kind": "file", "reason": reason})
                continue
            item = {
                "source": path,
                "path": relative,
                "device": metadata.st_dev,
                "inode": metadata.st_ino,
                "size": metadata.st_size,
                "mtime_ns": metadata.st_mtime_ns,
                "ctime_ns": metadata.st_ctime_ns,
                "executable": bool(metadata.st_mode & 0o111),
                "sqlite": entry.name.lower().endswith(SQLITE_SUFFIXES),
            }
            files.append(item)

    visit(source)
    return files, sorted(directories), sorted(exclusions, key=lambda item: item["path"])


def _make_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)


def _metadata_matches(actual: os.stat_result, expected: dict[str, object]) -> bool:
    return (
        actual.st_dev == expected["device"]
        and actual.st_ino == expected["inode"]
        and actual.st_size == expected["size"]
        and actual.st_mtime_ns == expected["mtime_ns"]
        and actual.st_ctime_ns == expected["ctime_ns"]
        and stat.S_ISREG(actual.st_mode)
    )


def _open_source_file(item: dict[str, object]) -> int:
    path = item["source"]
    assert isinstance(path, Path)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise SnapshotError(f"cannot open source file {item['path']}: {error}") from error
    if not _metadata_matches(os.fstat(descriptor), item):
        os.close(descriptor)
        raise SnapshotError(f"source file changed before capture: {item['path']}")
    return descriptor


def _has_sqlite_header(item: dict[str, object]) -> bool:
    descriptor = _open_source_file(item)
    try:
        header = os.read(descriptor, len(SQLITE_HEADER))
        if not _metadata_matches(os.fstat(descriptor), item):
            raise SnapshotError(f"source file changed while identifying SQLite: {item['path']}")
        return header == SQLITE_HEADER
    finally:
        os.close(descriptor)


def _refresh_capture_item(item: dict[str, object]) -> dict[str, object]:
    path = item["source"]
    assert isinstance(path, Path)
    relative = str(item["path"])
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise SnapshotError(f"cannot refresh source file before capture {relative}: {error}") from error
    if stat.S_ISLNK(metadata.st_mode):
        raise SnapshotError(f"source file became a symlink before capture: {relative}")
    if not stat.S_ISREG(metadata.st_mode):
        raise SnapshotError(f"source file became a non-regular file before capture: {relative}")
    refreshed = {
        "source": path,
        "path": relative,
        "device": metadata.st_dev,
        "inode": metadata.st_ino,
        "size": metadata.st_size,
        "mtime_ns": metadata.st_mtime_ns,
        "ctime_ns": metadata.st_ctime_ns,
        "executable": bool(metadata.st_mode & 0o111),
        "sqlite": path.name.lower().endswith(SQLITE_SUFFIXES),
        "captured_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    refreshed["sqlite"] = bool(refreshed["sqlite"]) or _has_sqlite_header(refreshed)
    return refreshed


def _copy_plain_file(item: dict[str, object], destination: Path) -> dict[str, object]:
    descriptor = _open_source_file(item)
    mode = 0o700 if item["executable"] else 0o600
    digest = hashlib.sha256()
    copied = 0
    _make_private_directory(destination.parent)
    try:
        output_descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            with os.fdopen(descriptor, "rb", closefd=False) as source_file, os.fdopen(
                output_descriptor, "wb", closefd=False
            ) as output_file:
                while chunk := source_file.read(COPY_CHUNK_SIZE):
                    output_file.write(chunk)
                    digest.update(chunk)
                    copied += len(chunk)
                output_file.flush()
                os.fsync(output_descriptor)
        finally:
            os.close(output_descriptor)
        current_descriptor_metadata = os.fstat(descriptor)
        try:
            current_path_metadata = os.lstat(item["source"])
        except OSError as error:
            raise SnapshotError(f"source file disappeared during capture: {item['path']}") from error
        if not _metadata_matches(current_descriptor_metadata, item) or not _metadata_matches(
            current_path_metadata, item
        ):
            raise SnapshotError(f"source file changed during capture: {item['path']}")
    finally:
        os.close(descriptor)
    os.chmod(destination, mode)
    return {
        "path": item["path"],
        "sha256": digest.hexdigest(),
        "size": copied,
        "source_mtime_ns": item["mtime_ns"],
        "captured_at_utc": item["captured_at_utc"],
        "executable": item["executable"],
    }


def _sqlite_uri(path: Path) -> str:
    return f"file:{quote(str(path), safe='/')}?mode=ro"


def _deadline_handler(deadline: float):
    return lambda: 1 if time.monotonic() > deadline else 0


def _inspect_sqlite(connection: sqlite3.Connection, deadline: float, relative: str) -> dict[str, object]:
    connection.set_progress_handler(_deadline_handler(deadline), 1_000)
    try:
        integrity_rows = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        if integrity_rows != ["ok"]:
            detail = "; ".join(str(value) for value in integrity_rows[:3])
            raise SnapshotError(f"SQLite integrity check failed for {relative}: {detail}")
        tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        counts: dict[str, int] = {}
        for table in tables:
            quoted_table = '"' + table.replace('"', '""') + '"'
            counts[table] = int(connection.execute(f"SELECT count(*) FROM {quoted_table}").fetchone()[0])
        return {"integrity_check": "ok", "table_counts": counts}
    except sqlite3.DatabaseError as error:
        raise SnapshotError(f"cannot inspect SQLite database {relative}: {error}") from error
    finally:
        connection.set_progress_handler(None, 0)


def _copy_sqlite_file(
    item: dict[str, object], destination: Path, sqlite_timeout: float
) -> dict[str, object]:
    relative = str(item["path"])
    source_path = item["source"]
    assert isinstance(source_path, Path)
    try:
        current = os.lstat(source_path)
    except OSError as error:
        raise SnapshotError(f"cannot inspect SQLite database {relative}: {error}") from error
    if stat.S_ISLNK(current.st_mode) or current.st_dev != item["device"] or current.st_ino != item["inode"]:
        raise SnapshotError(f"SQLite source changed before capture: {relative}")

    _make_private_directory(destination.parent)
    deadline = time.monotonic() + sqlite_timeout
    source_connection: sqlite3.Connection | None = None
    destination_connection: sqlite3.Connection | None = None
    try:
        source_connection = sqlite3.connect(
            _sqlite_uri(source_path), uri=True, timeout=sqlite_timeout
        )
        source_connection.execute("PRAGMA query_only=ON")
        source_connection.execute(f"PRAGMA busy_timeout={int(sqlite_timeout * 1000)}")
        source_connection.set_progress_handler(_deadline_handler(deadline), 1_000)
        destination_connection = sqlite3.connect(destination, timeout=sqlite_timeout)
        destination_connection.execute("PRAGMA journal_mode=DELETE")

        def check_backup_deadline(_status: int, _remaining: int, _total: int) -> None:
            if time.monotonic() > deadline:
                raise SnapshotError(f"SQLite capture timed out for {relative}")

        source_connection.backup(
            destination_connection, pages=256, progress=check_backup_deadline, sleep=0.05
        )
        destination_connection.execute("PRAGMA journal_mode=DELETE")
        destination_connection.close()
        destination_connection = None
        source_connection.close()
        source_connection = None
        os.chmod(destination, 0o700 if item["executable"] else 0o600)
        verified = sqlite3.connect(_sqlite_uri(destination), uri=True, timeout=sqlite_timeout)
        try:
            sqlite_metadata = _inspect_sqlite(verified, deadline, relative)
        finally:
            verified.close()
    except (sqlite3.DatabaseError, sqlite3.OperationalError) as error:
        raise SnapshotError(f"cannot capture SQLite database {relative}: {error}") from error
    finally:
        if destination_connection is not None:
            destination_connection.close()
        if source_connection is not None:
            source_connection.close()

    digest, size = _hash_regular_file(destination)
    return {
        "path": relative,
        "sha256": digest,
        "size": size,
        "source_mtime_ns": item["mtime_ns"],
        "captured_at_utc": item["captured_at_utc"],
        "executable": item["executable"],
        "sqlite": sqlite_metadata,
    }


def _hash_regular_file(path: Path) -> tuple[str, int]:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise SnapshotError(f"cannot read snapshot file {path}: {error}") from error
    digest = hashlib.sha256()
    size = 0
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SnapshotError(f"snapshot path is not a regular file: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as file:
            while chunk := file.read(COPY_CHUNK_SIZE):
                digest.update(chunk)
                size += len(chunk)
        after = os.fstat(descriptor)
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            raise SnapshotError(f"snapshot file changed while hashing: {path}")
    finally:
        os.close(descriptor)
    return digest.hexdigest(), size


def _write_manifest(path: Path, manifest: dict[str, object]) -> None:
    payload = (
        json.dumps(
            manifest,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as file:
            file.write(payload)
            file.flush()
            os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(path, 0o600)


def _publish_no_replace(staging: Path, output: Path) -> None:
    """Atomically rename staging to a destination that must not already exist."""
    old_path = os.fsencode(staging)
    new_path = os.fsencode(output)
    result: int
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        rename_exclusive = libc.renamex_np
        rename_exclusive.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename_exclusive.restype = ctypes.c_int
        result = rename_exclusive(old_path, new_path, 0x4)  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        try:
            rename_exclusive = libc.renameat2
        except AttributeError as error:
            raise SnapshotError("atomic no-replace publish is unsupported on this Linux system") from error
        rename_exclusive.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        rename_exclusive.restype = ctypes.c_int
        result = rename_exclusive(-100, old_path, -100, new_path, 0x1)  # AT_FDCWD, RENAME_NOREPLACE
    elif os.name == "nt":
        try:
            os.rename(staging, output)
            return
        except FileExistsError as error:
            raise SnapshotError(f"output appeared during capture and was not replaced: {output}") from error
    else:
        raise SnapshotError(f"atomic no-replace publish is unsupported on {sys.platform}")

    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number in (errno.EEXIST, errno.ENOTEMPTY):
        raise SnapshotError(f"output appeared during capture and was not replaced: {output}")
    if error_number in (errno.ENOSYS, errno.ENOTSUP, errno.EINVAL):
        raise SnapshotError(f"atomic no-replace publish is unsupported on {sys.platform}")
    raise SnapshotError(f"cannot publish snapshot at {output}: {os.strerror(error_number)}")


def create_snapshot(
    source: Path, output: Path, sqlite_timeout: float = DEFAULT_SQLITE_TIMEOUT
) -> Path:
    """Create a new snapshot without changing the source or any existing destination."""
    sqlite_timeout = _validate_timeout(sqlite_timeout)
    source_path, output_path = _resolved_create_paths(Path(source), Path(output))
    source_metadata = source_path.stat()
    files, directories, exclusions = _inventory(source_path)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_path.name}.partial-", dir=output_path.parent)
    )
    os.chmod(staging, 0o700)
    try:
        for relative in directories:
            _make_private_directory(staging / Path(relative))
        manifest_files: list[dict[str, object]] = []
        for item in files:
            item = _refresh_capture_item(item)
            destination = staging / Path(str(item["path"]))
            if item["sqlite"]:
                manifest_files.append(_copy_sqlite_file(item, destination, sqlite_timeout))
            else:
                manifest_files.append(_copy_plain_file(item, destination))
        manifest = {
            "format": "hermes-private-recovery-snapshot",
            "format_version": FORMAT_VERSION,
            "created_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "source": {
                "root_name": source_path.name,
                "root_mtime_ns": source_metadata.st_mtime_ns,
            },
            "consistency": {
                "level": "per-file-consistent",
                "description": (
                    "Each regular file is rejected if it changes while copied; each SQLite file is "
                    "captured independently with the SQLite backup API. The directory is not a global transaction."
                ),
            },
            "directories": directories,
            "files": sorted(manifest_files, key=lambda item: str(item["path"])),
            "exclusions": exclusions,
        }
        _write_manifest(staging / MANIFEST_NAME, manifest)
        verify_snapshot(staging, sqlite_timeout=sqlite_timeout)
        _publish_no_replace(staging, output_path)
        staging = Path()
        return output_path
    finally:
        if staging != Path() and staging.exists():
            shutil.rmtree(staging)


def _safe_manifest_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise SnapshotError(f"unsafe manifest path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise SnapshotError(f"unsafe manifest path: {value!r}")
    normalized = path.as_posix()
    if normalized != value:
        raise SnapshotError(f"unsafe manifest path: {value!r}")
    return normalized


def _load_manifest(snapshot: Path) -> dict[str, object]:
    path = snapshot / MANIFEST_NAME
    if path.is_symlink():
        raise SnapshotError(f"snapshot manifest is a symlink: {path}")
    try:
        metadata = path.stat()
        if metadata.st_size > MAX_MANIFEST_BYTES:
            raise SnapshotError(f"snapshot manifest exceeds {MAX_MANIFEST_BYTES} bytes")
        payload = path.read_bytes()
        manifest = json.loads(payload)
    except (OSError, json.JSONDecodeError) as error:
        raise SnapshotError(f"cannot read snapshot manifest: {error}") from error
    if not isinstance(manifest, dict):
        raise SnapshotError("snapshot manifest must be a JSON object")
    if manifest.get("format") != "hermes-private-recovery-snapshot" or manifest.get(
        "format_version"
    ) != FORMAT_VERSION:
        raise SnapshotError("unsupported snapshot manifest format")
    return manifest


def _actual_snapshot_paths(snapshot: Path) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()

    def visit(directory: Path) -> None:
        with os.scandir(directory) as iterator:
            entries = list(iterator)
        for entry in entries:
            path = Path(entry.path)
            relative = _relative_path(path, snapshot)
            metadata = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(metadata.st_mode):
                raise SnapshotError(f"snapshot contains symlink: {relative}")
            if stat.S_ISDIR(metadata.st_mode):
                directories.add(relative)
                visit(path)
            elif stat.S_ISREG(metadata.st_mode):
                files.add(relative)
            else:
                raise SnapshotError(f"snapshot contains unsupported file type: {relative}")

    visit(snapshot)
    return files, directories


def verify_snapshot(
    snapshot: Path, sqlite_timeout: float = DEFAULT_SQLITE_TIMEOUT
) -> dict[str, object]:
    """Verify manifest paths, privacy modes, hashes, and SQLite recovery metadata."""
    sqlite_timeout = _validate_timeout(sqlite_timeout)
    snapshot_argument = Path(snapshot).expanduser()
    if snapshot_argument.is_symlink():
        raise SnapshotError(f"snapshot root is a symlink: {snapshot_argument}")
    try:
        snapshot_path = snapshot_argument.resolve(strict=True)
    except FileNotFoundError as error:
        raise SnapshotError(f"snapshot does not exist: {snapshot_argument}") from error
    if not snapshot_path.is_dir():
        raise SnapshotError(f"snapshot is not a directory: {snapshot_path}")
    if stat.S_IMODE(snapshot_path.stat().st_mode) != 0o700:
        raise SnapshotError("snapshot root permissions must be 0700")

    manifest = _load_manifest(snapshot_path)
    raw_files = manifest.get("files")
    raw_directories = manifest.get("directories")
    raw_exclusions = manifest.get("exclusions")
    if not isinstance(raw_files, list) or not isinstance(raw_directories, list) or not isinstance(
        raw_exclusions, list
    ):
        raise SnapshotError("snapshot manifest file, directory, and exclusion lists are required")

    entries: dict[str, dict[str, object]] = {}
    for raw_entry in raw_files:
        if not isinstance(raw_entry, dict):
            raise SnapshotError("snapshot manifest contains an invalid file entry")
        relative = _safe_manifest_path(raw_entry.get("path"))
        if relative == MANIFEST_NAME or relative in entries:
            raise SnapshotError(f"duplicate or reserved manifest path: {relative}")
        entries[relative] = raw_entry
    expected_directories = {_safe_manifest_path(value) for value in raw_directories}
    if len(expected_directories) != len(raw_directories):
        raise SnapshotError("snapshot manifest contains duplicate directories")
    for exclusion in raw_exclusions:
        if not isinstance(exclusion, dict):
            raise SnapshotError("snapshot manifest contains an invalid exclusion")
        _safe_manifest_path(exclusion.get("path"))

    actual_files, actual_directories = _actual_snapshot_paths(snapshot_path)
    expected_files = set(entries) | {MANIFEST_NAME}
    if actual_files != expected_files:
        missing = sorted(expected_files - actual_files)
        unexpected = sorted(actual_files - expected_files)
        raise SnapshotError(f"snapshot file set mismatch; missing={missing}, unexpected={unexpected}")
    if actual_directories != expected_directories:
        missing = sorted(expected_directories - actual_directories)
        unexpected = sorted(actual_directories - expected_directories)
        raise SnapshotError(f"snapshot directory set mismatch; missing={missing}, unexpected={unexpected}")

    manifest_mode = stat.S_IMODE((snapshot_path / MANIFEST_NAME).stat().st_mode)
    if manifest_mode != 0o600:
        raise SnapshotError("snapshot manifest permissions must be 0600")
    for relative in sorted(expected_directories):
        if stat.S_IMODE((snapshot_path / Path(relative)).stat().st_mode) != 0o700:
            raise SnapshotError(f"snapshot directory permissions must be 0700: {relative}")

    for relative, entry in sorted(entries.items()):
        path = snapshot_path / Path(relative)
        expected_mode = 0o700 if entry.get("executable") is True else 0o600
        if stat.S_IMODE(path.stat().st_mode) != expected_mode:
            raise SnapshotError(f"snapshot file permissions mismatch: {relative}")
        digest, size = _hash_regular_file(path)
        if size != entry.get("size"):
            raise SnapshotError(f"size mismatch for snapshot file: {relative}")
        if digest != entry.get("sha256"):
            raise SnapshotError(f"hash mismatch for snapshot file: {relative}")
        sqlite_manifest = entry.get("sqlite")
        if sqlite_manifest is not None:
            if not isinstance(sqlite_manifest, dict):
                raise SnapshotError(f"invalid SQLite metadata for snapshot file: {relative}")
            connection = sqlite3.connect(_sqlite_uri(path), uri=True, timeout=sqlite_timeout)
            try:
                actual = _inspect_sqlite(connection, time.monotonic() + sqlite_timeout, relative)
            finally:
                connection.close()
            if actual != sqlite_manifest:
                raise SnapshotError(f"SQLite table counts mismatch for snapshot file: {relative}")
    return manifest


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create", help="create a new private snapshot")
    create.add_argument("--source", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--sqlite-timeout", type=float, default=DEFAULT_SQLITE_TIMEOUT)
    verify = subparsers.add_parser("verify", help="verify an existing snapshot")
    verify.add_argument("--snapshot", type=Path, required=True)
    verify.add_argument("--sqlite-timeout", type=float, default=DEFAULT_SQLITE_TIMEOUT)
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    old_umask = os.umask(0o077)
    try:
        if args.command == "create":
            result = create_snapshot(args.source, args.output, args.sqlite_timeout)
            print(f"Hermes recovery snapshot created and verified: {result}")
        else:
            verify_snapshot(args.snapshot, args.sqlite_timeout)
            print(f"Hermes recovery snapshot verified: {args.snapshot}")
        return 0
    except SnapshotError as error:
        print(f"snapshot error: {error}", file=sys.stderr)
        return 1
    finally:
        os.umask(old_umask)


if __name__ == "__main__":
    raise SystemExit(main())
