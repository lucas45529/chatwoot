#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import yaml

SCRIPT = Path(__file__).parents[1] / "scripts" / "render-server-state.py"
PROVISION_SCRIPT = Path(__file__).parents[1] / "scripts" / "provision-host.sh"
COMPOSE_FILE = Path(__file__).parents[1] / "compose.yaml"
SPEC = importlib.util.spec_from_file_location("render_server_state", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RenderServerStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.dashboard_credentials = self.root / "dashboard-credentials.json"
        self.output = self.root / "output"
        (self.source / "profiles" / "accounting-lead").mkdir(parents=True)
        (self.source / "cron").mkdir()
        (self.source / "state").mkdir()
        (self.source / "skills" / "sample").mkdir(parents=True)
        (self.source / "scripts").mkdir()
        (self.source / "skills" / "sample" / "SKILL.md").write_text("test\n")
        (self.source / "skills" / "broken").symlink_to("/missing/skill")
        (self.source / "scripts" / "stripe_payment_sync.py").write_text("pass\n")
        (self.source / "brief_assistent_soul.md").write_text("persona\n")
        (self.source / "state" / "stripe_seen.json").write_text("[]\n")

        config = {
            "model": {
                "default": "gpt-5.6-sol",
                "provider": "openai-codex",
                "base_url": "https://chatgpt.com/backend-api/codex",
            },
            "fallback_providers": [
                {
                    "provider": "dgx-deepseek",
                    "base_url": "http://127.0.0.1:8220/v1",
                },
                {
                    "provider": "openai-api",
                    "base_url": "https://api.openai.com/v1",
                },
            ],
            "providers": {"dgx-deepseek": {"base_url": "http://127.0.0.1:8220/v1"}},
            "agent": {"persona_prompt_file": "/Users/test/.hermes/persona.md"},
            "mcp_servers": {
                "cua-driver": {"command": "/Users/test/.local/bin/cua-driver"},
                "dgx-memory": {"command": "/Users/test/.local/bin/memory-mcp-dgx"},
            },
        }
        text = yaml.safe_dump(config, sort_keys=False)
        (self.source / "config.yaml").write_text(text)
        (self.source / ".env").write_text(
            "# SUDO_PASSWORD is intentionally local\nOPENAI_API_KEY=test-key\nSUDO_PASSWORD=must-not-copy\nTELEGRAM_BOT_TOKEN=test-token\n"
        )
        (self.source / "auth.json").write_text('{"refresh_token":"never-stage-auth"}\n')
        profile = self.source / "profiles" / "accounting-lead"
        (profile / "config.yaml").write_text(text)
        (profile / ".env").write_text("OPENAI_API_KEY=profile-key\nSUDO_PASSWORD=drop\n")
        (profile / "profile.yaml").write_text("description: Accounting\n")

        jobs = {
            "jobs": [
                {"name": "Stripe", "script": "stripe_payment_sync.py", "enabled": True},
                {"name": "Pulse", "script": "office_pulse_push.py", "enabled": True},
                {"name": "Sent", "script": "sent_mail_tracker.py", "enabled": True},
            ]
        }
        (self.source / "cron" / "jobs.json").write_text(json.dumps(jobs))
        self.dashboard_credentials.write_text(
            json.dumps(
                {
                    "username": "myinvest-admin",
                    "password": "never-copy-plaintext",
                    "password_hash": "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
                    "secret": "0123456789abcdef0123456789abcdef",
                }
            )
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_renders_dgx_free_least_privilege_state(self) -> None:
        MODULE.render(self.source, self.output, self.dashboard_credentials)
        config = yaml.safe_load((self.output / "config.yaml").read_text())

        self.assertEqual("openrouter", config["model"]["provider"])
        self.assertEqual(
            "x-ai/grok-4.6", config["model"]["default"]
        )
        self.assertEqual("https://openrouter.ai/api/v1", config["model"]["base_url"])
        self.assertEqual("chat_completions", config["model"]["api_mode"])
        profile_config = yaml.safe_load(
            (self.output / "profiles/accounting-lead/config.yaml").read_text()
        )
        self.assertEqual(config["model"], profile_config["model"])
        self.assertEqual("medium", config["agent"]["reasoning_effort"])
        self.assertEqual(
            "nvidia/nemotron-3-super-120b-a12b:free",
            config["fallback_providers"][0]["model"],
        )
        self.assertNotIn("cua-driver", config["mcp_servers"])
        self.assertNotIn("dgx-memory", config["mcp_servers"])
        self.assertEqual(
            "http://memory:8787",
            config["mcp_servers"]["memory-bridge"]["env"]["MEMORY_HTTP_URL"],
        )
        self.assertEqual(
            "/opt/data/brief_assistent_soul.md", config["agent"]["persona_prompt_file"]
        )

        env = (self.output / ".env").read_text()
        self.assertIn("OPENAI_API_KEY=test-key", env)
        self.assertNotIn("SUDO_PASSWORD", env)
        self.assertIn(
            "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH='scrypt$16384$8$1$c2FsdA==$aGFzaA=='",
            env,
        )
        self.assertFalse((self.output / "auth.json").exists())
        self.assertNotIn("never-copy-plaintext", env)
        self.assertNotIn("SUDO_PASSWORD", (self.output / "profiles/accounting-lead/.env").read_text())

        jobs = json.loads((self.output / "cron/jobs.json").read_text())["jobs"]
        enabled = {job["script"]: job["enabled"] for job in jobs}
        self.assertTrue(enabled["stripe_payment_sync.py"])
        self.assertFalse(enabled["office_pulse_push.py"])
        self.assertFalse(enabled["sent_mail_tracker.py"])
        self.assertFalse((self.output / "skills/broken").exists())
        self.assertTrue((self.output / ".hermes").is_symlink())
        self.assertEqual("/opt/memory-mcp", (self.output / ".claude/memory-mcp").readlink().as_posix())

    def test_compose_exec_cannot_consume_remote_heredoc(self) -> None:
        script = PROVISION_SCRIPT.read_text(encoding="utf-8").replace("\\\n", " ")
        compose_exec_commands = [
            line for line in script.splitlines() if "docker compose exec -T" in line
        ]
        self.assertTrue(compose_exec_commands)
        self.assertTrue(
            all("</dev/null" in command for command in compose_exec_commands),
            compose_exec_commands,
        )
        self.assertIn("--exclude='auth.json'", script)
        self.assertLess(
            script.index("ollama pull bge-m3 </dev/null"),
            script.index("docker compose up -d --force-recreate"),
        )

    def test_live_verification_requires_the_rendered_primary_model(self) -> None:
        script = PROVISION_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("c['model']['default'] == 'x-ai/grok-4.6'", script)
        self.assertNotIn("nvidia/nemotron-3-ultra-550b-a55b:free", script)

    def test_dashboard_shares_gateway_supervision(self) -> None:
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        self.assertNotIn("dashboard", compose["services"])
        gateway = compose["services"]["gateway"]
        self.assertEqual(["127.0.0.1:9119:9119"], gateway["ports"])
        self.assertEqual("true", compose["x-hermes-service"]["environment"]["HERMES_DASHBOARD"])
        self.assertIn("127.0.0.1:9119/health", gateway["healthcheck"]["test"][1])


if __name__ == "__main__":
    unittest.main()
