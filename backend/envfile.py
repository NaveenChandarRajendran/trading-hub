"""
envfile.py - reads backend/.env.local (KEY=VALUE lines) into the environment, so DATABASE_URL and the Dhan keys come
from that file wherever the backend is started from. Variables already set in the environment win. No dependency.
"""
import os


def load_env_file(path):
    """Sets the KEY=VALUE pairs of `path` that are not set yet. Ignores blank lines, # comments and 'export '."""
    if not os.path.exists(path):
        return {}
    loaded = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.removeprefix("export ").partition("=")
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value
                loaded[key] = value
    return loaded
