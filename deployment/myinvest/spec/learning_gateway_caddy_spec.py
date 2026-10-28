import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).parents[1] / 'scripts/prepare-learning-caddy.py'
spec = importlib.util.spec_from_file_location('learning_caddy', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SOURCE = '''support.example.test {
    # existing owner changes are retained verbatim
    handle /_agent/webhooks/chatwoot {
        reverse_proxy claude-agent:8080
    }
    handle /_agent/learning {
        uri strip_prefix /_agent
        reverse_proxy claude-agent:8080
    }
    handle /_agent/draft {
        reverse_proxy claude-agent:8080
    }
    handle /_finance-scanner/* {
        reverse_proxy scanner:8080
    }
}
'''


class LearningGatewayCaddyTests(unittest.TestCase):
    def test_changes_only_the_existing_learning_upstream(self):
        changed = module.prepare_learning_caddy(SOURCE)
        self.assertEqual(changed.count('reverse_proxy support-learning:8080'), 1)
        self.assertEqual(changed.count('reverse_proxy claude-agent:8080'), 2)
        self.assertEqual(changed.replace('reverse_proxy support-learning:8080', 'reverse_proxy claude-agent:8080'), SOURCE)

    def test_is_idempotent(self):
        first = module.prepare_learning_caddy(SOURCE)
        self.assertEqual(module.prepare_learning_caddy(first), first)

    def test_refuses_absent_duplicated_or_unexpected_routes(self):
        for source in [SOURCE.replace('/_agent/learning', '/other'), SOURCE + SOURCE,
                       SOURCE.replace('uri strip_prefix /_agent\n        reverse_proxy claude-agent:8080', 'uri strip_prefix /_agent\n        reverse_proxy unrelated:8080')]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.prepare_learning_caddy(source)


if __name__ == '__main__':
    unittest.main()
