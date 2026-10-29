"""Build-only producer of the fixed derivative and non-authorizing manifest."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

module_path, base_path, output, system = sys.argv[1:]
spec = importlib.util.spec_from_file_location('fixed_worker_perf', module_path)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
if system not in module.SYSTEMS.values():
    raise ValueError('Unsupported task perf system')
base = Path(base_path).read_bytes()
output = Path(output)
profile = output/'task-perf-seccomp.json'
profile.write_text(json.dumps(module.derivative(json.loads(base)), sort_keys=True)+'\n')
manifest = {'version': 1, 'purpose': 'worker-task-perf-profile-v1', 'system': system,
            'baseProfile': base_path, 'baseSHA256': hashlib.sha256(base).hexdigest(),
            'profile': str(profile), 'profileSHA256': hashlib.sha256(profile.read_bytes()).hexdigest()}
(output/'worker-perf-profile.json').write_text(json.dumps(manifest, sort_keys=True)+'\n')
