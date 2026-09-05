#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import stat
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "snapshot-hermes-state.py"
SPEC = importlib.util.spec_from_file_location("snapshot_hermes_state", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SnapshotHermesStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.output = self.root / "snapshot"
        self.source.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_sqlite(self, path: Path, values: tuple[str, ...] = ("remember me",)) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path)
        connection.execute("CREATE TABLE memories (body TEXT NOT NULL)")
        connection.executemany("INSERT INTO memories VALUES (?)", ((value,) for value in values))
        connection.commit()
        connection.close()

    def test_captures_complete_recovery_state_with_private_permissions(self) -> None:
        recovery_files = {
            "config.yaml": b"model: local\n",
            "models.json": b'{"default":"model"}\n',
            "auth.json": b'{"token":"private"}\n',
            ".env": b"API_TOKEN=private\n",
            "USER.md": b"Lucas\n",
            "MEMORY.md": b"Long-term memory\n",
            "SOUL.md": b"Be helpful\n",
            "persona.md": b"Brief assistant\n",
            "sessions/current.json": b'{"session":1}\n',
            "state/checkpoints/latest.json": b'{"step":8}\n',
            "profiles/research/knowledge/facts.md": b"verified fact\n",
            "cron/jobs.json": b'{"jobs":[]}\n',
            "skills/research/SKILL.md": b"instructions\n",
            "scripts/run.sh": b"#!/bin/sh\nexit 0\n",
            "assets/prompt.txt": b"asset\n",
            "work/notes.md": b"work\n",
        }
        for relative, content in recovery_files.items():
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        (self.source / "scripts" / "run.sh").chmod(0o755)
        self.write_sqlite(self.source / "state.db", ("one", "two"))
        self.write_sqlite(self.source / "profiles" / "research" / "state" / "profile.db")
        (self.source / "logs").mkdir()
        (self.source / "logs" / "agent.log").write_text("noise\n", encoding="utf-8")
        (self.source / "browser-use-venv").mkdir()
        (self.source / "browser-use-venv" / "python").write_text("generated\n", encoding="utf-8")
        (self.source / "media_cache").mkdir()
        (self.source / "media_cache" / "cached.bin").write_bytes(b"cache")
        (self.source / "state-snapshots").mkdir()
        (self.source / "state-snapshots" / "old.db").write_bytes(b"backup")
        (self.source / "work" / "checkout").mkdir()
        (self.source / "work" / "checkout" / ".git").mkdir()
        (self.source / "work" / "checkout" / "large-source.py").write_text("pass\n", encoding="utf-8")

        MODULE.create_snapshot(self.source, self.output)

        for relative, content in recovery_files.items():
            self.assertEqual(content, (self.output / relative).read_bytes(), relative)
        self.assertFalse((self.output / "logs").exists())
        self.assertFalse((self.output / "browser-use-venv").exists())
        self.assertFalse((self.output / "media_cache").exists())
        self.assertFalse((self.output / "state-snapshots").exists())
        self.assertFalse((self.output / "work" / "checkout").exists())
        self.assertEqual(0o700, stat.S_IMODE(self.output.stat().st_mode))
        self.assertEqual(0o600, stat.S_IMODE((self.output / "auth.json").stat().st_mode))
        self.assertEqual(0o700, stat.S_IMODE((self.output / "scripts" / "run.sh").stat().st_mode))

        manifest = json.loads((self.output / MODULE.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertNotIn(b"\n  ", (self.output / MODULE.MANIFEST_NAME).read_bytes())
        entries = {entry["path"]: entry for entry in manifest["files"]}
        self.assertEqual(2, entries["state.db"]["sqlite"]["table_counts"]["memories"])
        self.assertEqual("ok", entries["state.db"]["sqlite"]["integrity_check"])
        self.assertEqual("per-file-consistent", manifest["consistency"]["level"])
        self.assertIn({"path": "logs", "kind": "directory", "reason": "logs"}, manifest["exclusions"])
        self.assertIn(
            {"path": "work/checkout", "kind": "directory", "reason": "code-repository"},
            manifest["exclusions"],
        )
        MODULE.verify_snapshot(self.output)

    def test_sqlite_backup_includes_committed_wal_without_copying_sidecars(self) -> None:
        database = self.source / "state.db"
        connection = sqlite3.connect(database)
        self.assertEqual("wal", connection.execute("PRAGMA journal_mode=WAL").fetchone()[0])
        connection.execute("CREATE TABLE checkpoints (value TEXT NOT NULL)")
        connection.commit()
        connection.execute("INSERT INTO checkpoints VALUES ('wal-only')")
        connection.commit()
        self.assertTrue(Path(f"{database}-wal").exists())

        MODULE.create_snapshot(self.source, self.output)

        restored = sqlite3.connect(self.output / "state.db")
        self.assertEqual([("wal-only",)], restored.execute("SELECT value FROM checkpoints").fetchall())
        restored.close()
        self.assertFalse((self.output / "state.db-wal").exists())
        self.assertFalse((self.output / "state.db-shm").exists())
        manifest = json.loads((self.output / MODULE.MANIFEST_NAME).read_text(encoding="utf-8"))
        excluded = {entry["path"]: entry["reason"] for entry in manifest["exclusions"]}
        self.assertEqual("sqlite-sidecar", excluded["state.db-wal"])
        self.assertEqual("sqlite-sidecar", excluded["state.db-shm"])
        connection.close()

    def test_extensionless_sqlite_is_detected_and_captures_committed_wal(self) -> None:
        database = self.source / "History"
        connection = sqlite3.connect(database)
        self.assertEqual("wal", connection.execute("PRAGMA journal_mode=WAL").fetchone()[0])
        connection.execute("CREATE TABLE visits (url TEXT NOT NULL)")
        connection.commit()
        connection.execute("INSERT INTO visits VALUES ('https://example.test')")
        connection.commit()
        self.assertTrue(Path(f"{database}-wal").exists())

        MODULE.create_snapshot(self.source, self.output)

        restored = sqlite3.connect(self.output / "History")
        self.assertEqual(
            [("https://example.test",)], restored.execute("SELECT url FROM visits").fetchall()
        )
        restored.close()
        manifest = json.loads((self.output / MODULE.MANIFEST_NAME).read_text(encoding="utf-8"))
        entry = next(item for item in manifest["files"] if item["path"] == "History")
        self.assertEqual(1, entry["sqlite"]["table_counts"]["visits"])
        self.assertFalse((self.output / "History-wal").exists())
        self.assertFalse((self.output / "History-shm").exists())
        connection.close()

    def test_rejects_contained_or_existing_output_without_modifying_it(self) -> None:
        existing = self.root / "existing"
        existing.mkdir()
        marker = existing / "keep"
        marker.write_text("untouched", encoding="utf-8")

        with self.assertRaisesRegex(MODULE.SnapshotError, "already exists"):
            MODULE.create_snapshot(self.source, existing)
        self.assertEqual("untouched", marker.read_text(encoding="utf-8"))

        inside = self.source / "snapshot"
        with self.assertRaisesRegex(MODULE.SnapshotError, "contained"):
            MODULE.create_snapshot(self.source, inside)
        self.assertFalse(inside.exists())

        with self.assertRaisesRegex(MODULE.SnapshotError, "same|already exists"):
            MODULE.create_snapshot(self.source, self.source)
        self.assertTrue(self.source.is_dir())

    def test_destination_appearing_at_publish_is_not_replaced(self) -> None:
        (self.source / "MEMORY.md").write_text("memory\n", encoding="utf-8")
        original_publish = MODULE._publish_no_replace

        def publish_after_destination_appears(staging, output):
            output.mkdir()
            (output / "keep").write_text("untouched\n", encoding="utf-8")
            return original_publish(staging, output)

        MODULE._publish_no_replace = publish_after_destination_appears
        try:
            with self.assertRaisesRegex(MODULE.SnapshotError, "appeared during capture"):
                MODULE.create_snapshot(self.source, self.output)
        finally:
            MODULE._publish_no_replace = original_publish

        self.assertEqual("untouched\n", (self.output / "keep").read_text(encoding="utf-8"))
        self.assertFalse((self.output / "MEMORY.md").exists())

    def test_changes_permissions_only_inside_snapshot(self) -> None:
        parent = self.root / "destination-parent"
        parent.mkdir(mode=0o751)
        self.source.chmod(0o750)
        output = parent / "snapshot"
        (self.source / "MEMORY.md").write_text("memory\n", encoding="utf-8")

        MODULE.create_snapshot(self.source, output)

        self.assertEqual(0o751, stat.S_IMODE(parent.stat().st_mode))
        self.assertEqual(0o750, stat.S_IMODE(self.source.stat().st_mode))
        self.assertEqual(0o700, stat.S_IMODE(output.stat().st_mode))

    def test_corrupt_database_fails_without_publishing_partial_snapshot(self) -> None:
        (self.source / "state.db").write_bytes(b"not a sqlite database")

        with self.assertRaisesRegex(MODULE.SnapshotError, "state.db"):
            MODULE.create_snapshot(self.source, self.output)

        self.assertFalse(self.output.exists())

    def test_changing_plain_file_fails_without_publishing_partial_snapshot(self) -> None:
        memory = self.source / "MEMORY.md"
        memory.write_text("before\n", encoding="utf-8")
        original_open = MODULE._open_source_file
        open_count = 0

        def open_then_change(item):
            nonlocal open_count
            descriptor = original_open(item)
            open_count += 1
            if open_count == 2:
                memory.write_text("changed while copying\n", encoding="utf-8")
            return descriptor

        MODULE._open_source_file = open_then_change
        try:
            with self.assertRaisesRegex(MODULE.SnapshotError, "changed during capture"):
                MODULE.create_snapshot(self.source, self.output)
        finally:
            MODULE._open_source_file = original_open

        self.assertFalse(self.output.exists())

    def test_change_after_inventory_but_before_file_capture_uses_fresh_version(self) -> None:
        intake = self.source / "state" / "docops_external_upload_intake.json"
        intake.parent.mkdir()
        intake.write_text('{"version":"inventory"}\n', encoding="utf-8")
        original_inventory = MODULE._inventory

        def inventory_then_update(source):
            result = original_inventory(source)
            intake.write_text('{"version":"capture"}\n', encoding="utf-8")
            return result

        MODULE._inventory = inventory_then_update
        try:
            MODULE.create_snapshot(self.source, self.output)
        finally:
            MODULE._inventory = original_inventory

        fresh = b'{"version":"capture"}\n'
        self.assertEqual(fresh, intake.read_bytes())
        self.assertEqual(fresh, (self.output / "state" / intake.name).read_bytes())
        manifest = json.loads((self.output / MODULE.MANIFEST_NAME).read_text(encoding="utf-8"))
        entry = next(item for item in manifest["files"] if item["path"].endswith(intake.name))
        self.assertEqual(intake.stat().st_mtime_ns, entry["source_mtime_ns"])
        self.assertIn("captured_at_utc", entry)

    def test_source_symlinks_are_explicitly_excluded_and_output_symlinks_are_rejected(self) -> None:
        outside = self.root / "outside"
        outside.write_text("do not follow", encoding="utf-8")
        (self.source / "auth.json").symlink_to(outside)
        (self.source / "dangling").symlink_to(self.root / "missing")
        (self.source / "cycle").symlink_to("cycle")

        MODULE.create_snapshot(self.source, self.output)

        manifest = json.loads((self.output / MODULE.MANIFEST_NAME).read_text(encoding="utf-8"))
        exclusions = {
            entry["path"]: (entry["kind"], entry["reason"]) for entry in manifest["exclusions"]
        }
        for relative in ("auth.json", "dangling", "cycle"):
            self.assertEqual(("symlink", "symlink-not-followed"), exclusions[relative])
            self.assertFalse(os.path.lexists(self.output / relative))

        (self.output / "injected-link").symlink_to(outside)
        with self.assertRaisesRegex(MODULE.SnapshotError, "contains symlink: injected-link"):
            MODULE.verify_snapshot(self.output)

    def test_verify_detects_hash_tamper_and_manifest_path_traversal(self) -> None:
        (self.source / "MEMORY.md").write_text("original\n", encoding="utf-8")
        MODULE.create_snapshot(self.source, self.output)
        (self.output / "MEMORY.md").write_text("tampered\n", encoding="utf-8")
        with self.assertRaisesRegex(MODULE.SnapshotError, "hash mismatch"):
            MODULE.verify_snapshot(self.output)

        (self.output / "MEMORY.md").write_text("original\n", encoding="utf-8")
        manifest_path = self.output / MODULE.MANIFEST_NAME
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"][0]["path"] = "../escape"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        os.chmod(manifest_path, 0o600)
        with self.assertRaisesRegex(MODULE.SnapshotError, "unsafe manifest path"):
            MODULE.verify_snapshot(self.output)

    def test_manifest_reader_accepts_valid_manifest_larger_than_old_limit(self) -> None:
        snapshot = self.root / "large-manifest-snapshot"
        snapshot.mkdir(mode=0o700)
        manifest_path = snapshot / MODULE.MANIFEST_NAME
        manifest = {
            "format": "hermes-private-recovery-snapshot",
            "format_version": MODULE.FORMAT_VERSION,
            "directories": [],
            "files": [],
            "exclusions": [],
        }
        payload = json.dumps(manifest).encode("utf-8") + b" " * (17 * 1024 * 1024)
        manifest_path.write_bytes(payload)
        manifest_path.chmod(0o600)

        loaded = MODULE._load_manifest(snapshot)

        self.assertEqual(MODULE.FORMAT_VERSION, loaded["format_version"])


if __name__ == "__main__":
    unittest.main()
