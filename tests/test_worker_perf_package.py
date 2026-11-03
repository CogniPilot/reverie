"""Actual locked-Nix derivation identities; evaluation only, no perf/engine/build effects."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('nix'), 'normal Nix evaluator unavailable')
class WorkerPerfPackageTests(unittest.TestCase):
    def test_only_actual_profile_inputs_change_the_fixed_artifact_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            def source(name, *, builder_extra='', module_extra='', unrelated='website A'):
                target = work / name
                for relative, extra in [('nix/worker-perf-profile.py', builder_extra),
                                        ('python/reverie/worker_perf.py', module_extra)]:
                    path = target / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes((ROOT / relative).read_bytes() + extra.encode())
                (target / 'unrelated-website.txt').write_text(unrelated)
                return target
            sources = {name: source(name, **changes) for name, changes in {
                'before': {}, 'release': {'unrelated': 'website B'},
                'builder': {'builder_extra': '\n# changed builder input\n'},
                'module': {'module_extra': '\n# changed policy module input\n'},
            }.items()}
            paths = {name: json.dumps(str(path)) for name, path in sources.items()}
            root = json.dumps(str(ROOT))
            expression = r'''let
              root = builtins.toPath ROOT;
              lock = (builtins.fromJSON (builtins.readFile (root + "/flake.lock"))).nodes.nixpkgs.locked;
              pkgs = import (builtins.fetchTree lock).outPath { system = builtins.currentSystem; };
              factory = import (root + "/nix/worker-perf-profile.nix");
              base = import (root + "/nix/worker-docker-profile.nix") { inherit pkgs; };
              make = packages: selectedBase: source: factory {
                pkgs = packages; src = builtins.toPath source; baseProfile = selectedBase;
              };
              before = make pkgs base BEFORE;
              release = make pkgs base RELEASE;
              builder = make pkgs base BUILDER;
              module = make pkgs base MODULE;
              otherBase = make pkgs (pkgs.writeText "different-base.json" "changed base bytes") BEFORE;
              otherPkgs = make (pkgs // {
                python3 = pkgs.python3.overrideAttrs (old: { pname = old.pname + "-identity-control"; });
              }) base BEFORE;
              identity = value: { drv = value.drvPath; out = value.outPath; };
            in { inherit (pkgs.stdenv.hostPlatform) system;
              before = identity before; release = identity release;
              builder = identity builder; module = identity module;
              otherBase = identity otherBase; otherPkgs = identity otherPkgs;
            }'''
            for name, value in {'ROOT': root, **{key.upper(): val for key, val in paths.items()}}.items():
                expression = expression.replace(name, value)
            result = subprocess.run(['nix', '--extra-experimental-features', 'nix-command flakes',
                                     'eval', '--offline', '--impure', '--json', '--expr', expression],
                                    capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertEqual(value['before'], value['release'])
            for key in ('builder', 'module', 'otherBase', 'otherPkgs'):
                with self.subTest(changed=key):
                    self.assertNotEqual(value['before']['drv'], value[key]['drv'])
                    self.assertNotEqual(value['before']['out'], value[key]['out'])


if __name__ == '__main__':
    unittest.main()
