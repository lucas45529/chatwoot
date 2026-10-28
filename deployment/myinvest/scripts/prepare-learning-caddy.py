#!/usr/bin/env python3
"""Change only the existing signed learning upstream; retain all other live configuration."""
from pathlib import Path
import os
import re
import sys


def code_mask(source: str) -> str:
    masked = list(source)
    quote = None
    comment = False
    index = 0
    while index < len(source):
        char = source[index]
        if comment:
            if char == '\n':
                comment = False
            else:
                masked[index] = ' '
        elif quote:
            if char != '\n':
                masked[index] = ' '
            if char == quote:
                quote = None
            elif char == '\\' and quote == '"':
                index += 1
                if index >= len(source):
                    raise ValueError('incomplete_caddy_escape')
                if source[index] != '\n':
                    masked[index] = ' '
        elif char == '#':
            comment = True
            masked[index] = ' '
        elif char in ('"', '`'):
            quote = char
            masked[index] = ' '
        elif char == '\\':
            masked[index] = ' '
            index += 1
            if index >= len(source):
                raise ValueError('incomplete_caddy_escape')
            if source[index] != '\n':
                masked[index] = ' '
        index += 1
    if quote:
        raise ValueError('unclosed_caddy_quote')
    return ''.join(masked)


def prepare_learning_caddy(source: str) -> str:
    code = code_mask(source)
    balance = 0
    for char in code:
        if char == '{':
            balance += 1
        elif char == '}':
            balance -= 1
            if balance < 0:
                raise ValueError('unbalanced_caddy_blocks')
    if balance != 0:
        raise ValueError('unbalanced_caddy_blocks')
    headers = list(re.finditer(r'(?m)^[ \t]*handle[ \t]+/_agent/learning[ \t]*(?P<open>\{)[ \t]*$', code))
    if len(headers) != 1:
        raise ValueError('learning_route_must_exist_exactly_once')
    header = headers[0]
    depth = 0
    end = None
    for index in range(header.start('open'), len(code)):
        if code[index] == '{':
            depth += 1
        elif code[index] == '}':
            depth -= 1
            if depth == 0:
                end = index + 1
                break
    if end is None:
        raise ValueError('unclosed_learning_route')
    block = code[header.start():end]
    directives = list(re.finditer(r'(?m)^[ \t]*reverse_proxy\b[^\n]*', block))
    upstreams = list(re.finditer(r'(?m)^[ \t]*reverse_proxy[ \t]+(?P<target>[^\s{}]+)[ \t]*(?:\{[ \t]*)?$', block))
    if len(directives) != 1 or len(upstreams) != 1:
        raise ValueError('unexpected_learning_upstream')
    proxy = upstreams[0]
    target = proxy.group('target')
    if target == 'support-learning:8080':
        return source
    if target != 'claude-agent:8080':
        raise ValueError('unexpected_learning_upstream')
    start = header.start() + proxy.start('target')
    finish = header.start() + proxy.end('target')
    return source[:start] + 'support-learning:8080' + source[finish:]


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
