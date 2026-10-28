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

    def test_mismatched_indentation_cannot_capture_following_customer_route(self):
        source = '''support.example.test {
    handle /_agent/learning {
        reverse_proxy current-learning:8080
  }
    handle /_agent/webhooks/chatwoot {
        reverse_proxy claude-agent:8080
    }
}
'''
        with self.assertRaises(ValueError):
            module.prepare_learning_caddy(source)

    def test_valid_learning_route_uses_braces_not_closing_indentation(self):
        source = '''support.example.test {
    handle /_agent/learning {
        reverse_proxy claude-agent:8080
  }
    handle /_agent/webhooks/chatwoot {
        reverse_proxy claude-agent:8080
    }
}
'''
        changed = module.prepare_learning_caddy(source)
        self.assertEqual(changed.count('reverse_proxy support-learning:8080'), 1)
        self.assertIn('handle /_agent/webhooks/chatwoot {\n        reverse_proxy claude-agent:8080', changed)

    def test_ignores_comment_and_quoted_braces_or_upstream_text(self):
        source = SOURCE.replace('uri strip_prefix /_agent', 'header X-Note "{ reverse_proxy claude-agent:8080 }"\n        # } reverse_proxy claude-agent:8080\n        uri strip_prefix /_agent')
        changed = module.prepare_learning_caddy(source)
        self.assertIn('header X-Note "{ reverse_proxy claude-agent:8080 }"', changed)
        self.assertIn('# } reverse_proxy claude-agent:8080', changed)
        self.assertEqual(changed.count('reverse_proxy support-learning:8080'), 1)

    def test_refuses_unclosed_file_block_or_quote(self):
        for source in [SOURCE[:SOURCE.index('    handle /_agent/draft')].rstrip(), SOURCE + '\n"unclosed']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.prepare_learning_caddy(source)

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
