#!/usr/bin/env python3
"""Create local credential-process profiles without storing credentials."""
from pathlib import Path
import os
import shlex

root = Path(__file__).resolve().parent.parent
destination = root / '.aws' / 'delivery-config'
destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
runtime = shlex.quote(str(root / 'scripts' / 'aws-restricted-session.py'))
s3 = shlex.quote(str(root / 'scripts' / 'aws-s3-session.py'))
contents = (f'[profile delivery-runtime]\ncredential_process = python3 {runtime}\n\n'
            f'[profile delivery-s3]\ncredential_process = python3 {s3}\n')
try:
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    raise SystemExit(f'{destination} already exists; inspect it before replacing it')
with os.fdopen(fd, 'w', encoding='utf-8') as output:
    output.write(contents)
print(f'Created {destination} (no credentials stored)')
