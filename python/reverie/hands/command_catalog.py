"""Reviewed fixed telemetry keys. Alias text and unknown tokens never leave caller."""
CATALOG = {
    'shell': ('bash', '/bin/bash', 'sh', '/bin/sh'),
    'python': ('python', 'python3', '/bin/python', '/bin/python3'),
    'git': ('git', '/bin/git'),
    'zip': ('zip', '/bin/zip'),
}
ALIASES = {alias: key for key, aliases in CATALOG.items() for alias in aliases}
