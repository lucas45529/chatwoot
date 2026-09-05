#!/usr/bin/env python3

import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts/mac-access.py"
SPEC = importlib.util.spec_from_file_location("mac_access", SCRIPT)
mac_access = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(mac_access)


class MacAccessTest(unittest.TestCase):
    def fake_keygen(self, argv, **kwargs):
        key_path = Path(argv[argv.index("-f") + 1])
        key_path.write_text("dedicated-private-key", encoding="utf-8")
        suffix = "HOST" if "host" in key_path.name else "CLIENT"
        key_path.with_name(key_path.name + ".pub").write_text(
            f"ssh-ed25519 AAAA{suffix} hermes-test\n", encoding="utf-8"
        )
        return subprocess.CompletedProcess(argv, 0)

    def test_prepare_generates_restricted_pinned_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "new-bundle"
            with mock.patch.object(mac_access, "current_username", return_value="lucas"), mock.patch.object(
                mac_access.subprocess, "run", side_effect=self.fake_keygen
            ) as run:
                mac_access.prepare(output)

            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
            for name in ("sshd_config", "authorized_keys", "known_hosts", "id_ed25519", "ssh_host_ed25519_key"):
                self.assertEqual(stat.S_IMODE((output / name).stat().st_mode), 0o600)
            authorized = (output / "authorized_keys").read_text(encoding="utf-8")
            self.assertEqual(authorized, 'restrict,from="127.0.0.1" ssh-ed25519 AAAACLIENT hermes-test\n')
            known_hosts = (output / "known_hosts").read_text(encoding="utf-8")
            self.assertEqual(known_hosts, "hermes-mac ssh-ed25519 AAAAHOST hermes-test\n")
            config = (output / "sshd_config").read_text(encoding="utf-8")
            for setting in (
                "ListenAddress 127.0.0.1",
                "Port 22022",
                "PidFile none",
                "AllowUsers lucas",
                "PermitRootLogin no",
                "PasswordAuthentication no",
                "KbdInteractiveAuthentication no",
                "UsePAM no",
                "PermitUserEnvironment no",
                "PermitUserRC no",
                "DisableForwarding yes",
                "PermitTTY no",
            ):
                self.assertIn(setting, config)
            calls = [call.args[0] for call in run.call_args_list]
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(command[:5] == ["ssh-keygen", "-q", "-t", "ed25519", "-N"] for command in calls))
            self.assertTrue(all(call.kwargs["shell"] is False for call in run.call_args_list))

    def test_prepare_is_create_only(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "existing"
            output.mkdir()
            marker = output / "keep"
            marker.write_text("untouched", encoding="utf-8")
            with mock.patch.object(mac_access, "current_username", return_value="lucas"):
                with self.assertRaises(mac_access.MacAccessError):
                    mac_access.prepare(output)
            self.assertEqual(marker.read_text(encoding="utf-8"), "untouched")

    def test_prepare_rejects_privileged_or_invalid_scope(self):
        with self.assertRaises(mac_access.MacAccessError):
            mac_access.validate_port(22)
        with self.assertRaises(mac_access.MacAccessError):
            mac_access.validate_port(70000)
        with mock.patch.object(mac_access.os, "geteuid", return_value=0), mock.patch.object(
            mac_access.pwd, "getpwuid", return_value=mock.Mock(pw_name="root")
        ):
            with self.assertRaises(mac_access.MacAccessError):
                mac_access.current_username()

    def test_current_username_ignores_spoofed_environment(self):
        with mock.patch.dict(mac_access.os.environ, {"USER": "root", "LOGNAME": "root"}), mock.patch.object(
            mac_access.os, "geteuid", return_value=501
        ), mock.patch.object(mac_access.pwd, "getpwuid", return_value=mock.Mock(pw_name="lucas")):
            self.assertEqual("lucas", mac_access.current_username())

    def test_serve_uses_non_shell_sshd_argv(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "sshd_config"
            config.write_text("# test\n", encoding="utf-8")
            with mock.patch.object(mac_access, "_run") as run:
                self.assertEqual(mac_access.serve(config), 0)
            run.assert_called_once_with(["/usr/sbin/sshd", "-D", "-e", "-f", str(config.resolve())])

    def test_probe_pins_alias_and_runs_harmless_read(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            (output / "id_ed25519").write_text("private", encoding="utf-8")
            (output / "known_hosts").write_text("pinned", encoding="utf-8")
            with mock.patch.object(mac_access, "current_username", return_value="lucas"), mock.patch.object(
                mac_access, "_run"
            ) as run:
                self.assertEqual(mac_access.probe(output, read_path="/Users/lucas/My Docs/check.txt"), 0)
            command = run.call_args.args[0]
            self.assertIn("-F", command)
            self.assertIn("/dev/null", command)
            self.assertIn("-i", command)
            self.assertIn("-o", command)
            self.assertIn("StrictHostKeyChecking=yes", command)
            self.assertIn("HostKeyAlias=hermes-mac", command)
            self.assertIn("UserKnownHostsFile=" + str((output / "known_hosts").resolve()), command)
            self.assertEqual(command[-3:], ["--", "lucas@127.0.0.1", "pwd && test -r '/Users/lucas/My Docs/check.txt' && wc -c < '/Users/lucas/My Docs/check.txt'"])

    def test_prepare_rejects_dangling_symlink_and_expanded_whitespace(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp)
            dangling = parent / "dangling"
            dangling.symlink_to(parent / "missing")
            with self.assertRaises(mac_access.MacAccessError):
                mac_access._new_output(dangling)

            spaced_home = parent / "home with spaces"
            with mock.patch.dict(os.environ, {"HOME": str(spaced_home)}), self.assertRaises(mac_access.MacAccessError):
                mac_access._new_output("~/bundle")


if __name__ == "__main__":
    unittest.main()
