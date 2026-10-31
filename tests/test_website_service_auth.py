"""Closed startup facts and pure Nix option evaluation, never an auth file read."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest

from reverie.website_service_auth import config_path, web_arguments, WEB


class ServiceAuthStartupTests(unittest.TestCase):
    def test_guest_path_and_closed_web_options(self):
        selected = '/run/private-services/service-auth.json'
        self.assertEqual(config_path(selected), selected)
        self.assertEqual(web_arguments([*WEB, '--service-auth-config', selected]), selected)
        self.assertIsNone(web_arguments(WEB))
        for value in (None, Path(selected), '', '/', '//auth/file', '/auth/../file',
                      '/auth/./file', '/auth//file', '/auth/file/', '/auth/\nfile', '/' + 'a' * 4096):
            with self.subTest(value=value), self.assertRaises(ValueError):config_path(value)
        for tail in (['--service-auth-config'], ['--service-auth-config=' + selected],
                     ['--service-auth-config', selected, '--service-auth-config', selected],
                     ['--unknown'], ['--resource-replacement', '--service-auth-config', selected]):
            with self.subTest(tail=tail), self.assertRaises(ValueError):web_arguments([*WEB, *tail])

    @unittest.skipUnless(shutil.which('nix-instantiate'), 'normal Nix evaluator unavailable')
    def test_nix_option_rejects_path_values_and_builds_only_selected_fixed_arguments(self):
        root = Path(__file__).resolve().parents[1]
        # Pure constructor ports expose generated webArgs; no derivation/build,
        # Nixpkgs lookup, secret input, engine, service or application is used.
        expression = '''let
          lib = rec {
            hasPrefix = p: s: builtins.substring 0 (builtins.stringLength p) s == p;
            hasSuffix = p: s: builtins.stringLength s >= builtins.stringLength p &&
              builtins.substring (builtins.stringLength s - builtins.stringLength p) (builtins.stringLength p) s == p;
            hasInfix = p: s: builtins.match (".*" + p + ".*") s != null;
            splitString = p: s: builtins.filter builtins.isString (builtins.split p s);
            optionals = b: x: if b then x else [];
          };
          select = import ROOT/nix/service-auth-config.nix { inherit lib; };
          valid = value: (builtins.tryEval (builtins.deepSeq (select value) true)).success;
          pkgs = { inherit lib; symlinkJoin = a: a.passthru;
            writeTextFile = a: a.passthru; };
          args = value: (import ROOT/nix/owner-terminal-host.nix {
            inherit pkgs; src = ROOT; console = "/nix/store/console"; memory = "/nix/store/python";
            memoryPackage = "/nix/store/memory"; entrypoint = "/nix/store/entry";
            serviceAuthConfig = value;
          }).website.webArgs;
        in { invalid = map valid [ ROOT null 7 true "relative" "/" "//file" "/a/../b" "/a/./b" "/a//b" "/a/b/" ];
          default = args null; selected = args "/run/private-services/service-auth.json"; }
        '''.replace('ROOT', str(root))
        result = subprocess.run(['nix-instantiate', '--eval', '--strict', '--json', '--expr', expression],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['invalid'], [False, True, False, False, False, False, False, False, False, False, False])
        self.assertEqual(value['default'], WEB)
        self.assertEqual(value['selected'], [*WEB, '--service-auth-config', '/run/private-services/service-auth.json'])
