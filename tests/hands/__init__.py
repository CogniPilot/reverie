import sys
from pathlib import Path
_root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_root / "python/reverie/hands"))
sys.path.insert(0, str(Path(__file__).parent))
