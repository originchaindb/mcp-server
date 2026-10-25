"""Create a detached checkout for read-only promotion verification."""
import re
import subprocess
import sys
from pathlib import Path

from release_preview import load

if __name__ == '__main__':
    selected = load(Path(sys.argv[1]) / 'selected-preview.json')
    if not re.fullmatch('[0-9a-f]{40}', selected['head']):
        raise ValueError('Invalid source commit')
    subprocess.run(['git', 'worktree', 'add', '--detach', sys.argv[2], selected['head']], check=True)
