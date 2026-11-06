"""Actual locked-Nix derivation identities; evaluation only, no perf/engine/build effects."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('nix'), 'normal Nix evaluator unavailable')
class WorkerPerfPackageTests(unittest.TestCase):
    def test_only_actual_profile_inputs_change_the_fixed_artifact_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            def source(name, *, builder_extra='', module_extra='', unrelated='website A'):
                target = work / name
                target.mkdir()
                for filename in ('Cargo.toml', 'Cargo.lock'):
                    shutil.copyfile(ROOT / filename, target / filename)
                for crate_name in ('reverie-core', 'reverie-contracts', 'reverie-policy-artifacts'):
                    shutil.copytree(ROOT / 'crates' / crate_name, target / 'crates' / crate_name)
                for relative, extra in [('crates/reverie-policy-artifacts/src/main.rs', builder_extra),
                                        ('crates/reverie-core/src/task_perf.rs', module_extra)]:
                    path = target / relative
                    path.write_bytes(path.read_bytes() + extra.encode())
                if name == 'release':
                    # New excluded workspace members/dependencies and unrelated
                    # lock entries must not select a different artifact.
                    cargo = target / 'Cargo.toml'
                    original = cargo.read_text()
                    members = tomllib.loads(original)['workspace']['members']
                    self.assertNotIn('crates/unrelated', members)
                    array = re.search(r'(?m)^members\s*=\s*\[', original)
                    self.assertIsNotNone(array, 'workspace members declaration must be perturbed')
                    updated = original[:array.end()] + '\n"crates/unrelated",\n' + original[array.end():]
                    self.assertEqual(tomllib.loads(updated)['workspace']['members'], ['crates/unrelated', *members])
                    self.assertEqual(updated.count('[workspace.dependencies]'), 1)
                    cargo.write_text(updated.replace('[workspace.dependencies]', '[workspace.dependencies]\nunrelated = "1"'))
                    with (target / 'Cargo.lock').open('a') as file:
                        file.write('\n[[package]]\nname = "unrelated"\nversion = "1.0.0"\n')
                if name in ('target_junk', 'metadata'):
                    suffix = 'target/cache-entry' if name == 'target_junk' else '.git/index'
                    ignored = target / 'crates/reverie-core' / suffix
                    ignored.parent.mkdir(parents=True)
                    ignored.write_text('unrelated generated state\n')
                (target / 'unrelated-website.txt').write_text(unrelated)
                return target
            sources = {name: source(name, **changes) for name, changes in {
                'before': {}, 'release': {'unrelated': 'website B'},
                'builder': {'builder_extra': '\n// changed builder input\n'},
                'module': {'module_extra': '\n// changed policy module input\n'},
                'target_junk': {}, 'metadata': {},
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
                pkgs = packages;
                src = builtins.path { name = "policy-fixture-source"; path = builtins.toPath source; };
                baseProfile = selectedBase;
              };
              before = make pkgs base BEFORE;
              release = make pkgs base RELEASE;
              builder = make pkgs base BUILDER;
              module = make pkgs base MODULE;
              targetJunk = make pkgs base TARGET_JUNK;
              metadata = make pkgs base METADATA;
              otherBase = make pkgs (pkgs.writeText "different-base.json" "changed base bytes") BEFORE;
              otherPkgs = make (pkgs // {
                rustPlatform = pkgs.rustPlatform // {
                  buildRustPackage = attrs: pkgs.rustPlatform.buildRustPackage
                    (attrs // { RUSTFLAGS = "-Ccodegen-units=2"; });
                };
              }) base BEFORE;
              identity = value: { drv = value.drvPath; out = value.outPath; };
            in { inherit (pkgs.stdenv.hostPlatform) system;
              before = identity before; release = identity release;
              builder = identity builder; module = identity module;
              targetJunk = identity targetJunk; metadata = identity metadata;
              otherBase = identity otherBase; otherPkgs = identity otherPkgs;
            }'''
            for name, value in {'ROOT': root, **{key.upper(): val for key, val in paths.items()}}.items():
                expression = expression.replace(name, value)
            result = subprocess.run(['nix', '--extra-experimental-features', 'nix-command flakes',
                                     'eval', '--offline', '--impure', '--json', '--expr', expression],
                                    capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertEqual(value['before'], value['release'])
            self.assertEqual(value['before'], value['targetJunk'])
            self.assertEqual(value['before'], value['metadata'])
            for key in ('builder', 'module', 'otherBase', 'otherPkgs'):
                with self.subTest(changed=key):
                    self.assertNotEqual(value['before']['drv'], value[key]['drv'])
                    self.assertNotEqual(value['before']['out'], value[key]['out'])


if __name__ == '__main__':
    unittest.main()
