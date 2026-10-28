#!/usr/bin/env python3
"""Change only the existing signed learning upstream; retain all other live configuration."""
from pathlib import Path
import os
import re
import sys


def prepare_learning_caddy(source: str) -> str:
    pattern = re.compile(r'(?ms)^([ \t]*)handle /_agent/learning \{\n(.*?)^\1\}')
    matches = list(pattern.finditer(source))
    if len(matches) != 1:
        raise ValueError('learning_route_must_exist_exactly_once')
    match = matches[0]
    block = match.group(0)
    old = 'reverse_proxy claude-agent:8080'
    new = 'reverse_proxy support-learning:8080'
    if block.count(new) == 1 and old not in block:
        return source
    if block.count(old) != 1 or new in block:
        raise ValueError('unexpected_learning_upstream')
    changed = block.replace(old, new, 1)
    return source[:match.start()] + changed + source[match.end():]


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: prepare-learning-caddy.py SOURCE NEW_DESTINATION')
    try:
        changed = prepare_learning_caddy(Path(sys.argv[1]).read_text())
        os.umask(0o077)
        with Path(sys.argv[2]).open('x') as output:
            output.write(changed)
    except (OSError, ValueError) as error:
        raise SystemExit(type(error).__name__)
