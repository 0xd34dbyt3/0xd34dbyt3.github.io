"""Reject dangerous tracked files. Reports paths only, never secret values.

This is a gate, not a substitute for scanning existing Git history before public use.
"""
import re
import subprocess
import sys
from pathlib import Path

result = subprocess.run(['git', 'ls-files', '-z'], capture_output=True)
if result.returncode:
    sys.exit('Repository check unavailable: no valid Git repository; do not publish an unchecked folder.')
bad = []
for raw in result.stdout.split(b'\0'):
    if not raw:
        continue
    name = raw.decode('utf-8')
    path = Path(name)
    if (any(part in {'.private', '.aws', '.codex', 'node_modules', 'server'} for part in path.parts)
            or path.name.startswith('.env') or path.suffix.lower() in {'.zip', '.log', '.sql', '.db', '.sqlite', '.sqlite3', '.bak', '.backup', '.pem', '.key'}):
        bad.append(name)
        continue
    if path.is_file() and path.suffix in {'.json', '.js', '.cjs', '.html', '.yml', '.yaml', '.md'}:
        data = path.read_text(errors='replace')
        if re.search(r'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}', data):
            bad.append(name)
if bad:
    print('Unsafe tracked paths:\n' + '\n'.join(sorted(set(bad))))
    sys.exit(1)
print('Tracked source path/token-pattern gate passed; history requires separate review.')
