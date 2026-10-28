# Optional owner-local metadata tooling, never a driver/service/permission installer.
{ pkgs, src }:
let python = pkgs.python3.withPackages (ps: [ ps.pyyaml ]);
in pkgs.writeShellApplication {
  name = "reverie-worker-gpu";
  runtimeInputs = [ python pkgs.docker-client ];
  text = ''exec python3 -I -B ${src}/python/reverie/worker_gpu_preflight.py "$@"'';
  derivationArgs.postCheck = ''
    ${python}/bin/python3 -I -B -c '
    import sys,unittest
    sys.path[:0]=["${src}/python","${src}"]
    suite=unittest.defaultTestLoader.loadTestsFromName("tests.test_worker_gpu_preflight.GPUPreflightTests.test_yaml_specs_use_safe_unique_alias_free_parser")
    result=unittest.TextTestRunner().run(suite)
    assert result.wasSuccessful() and result.testsRun==1 and not result.skipped
    '
    "$target" --help >/dev/null
  '';
}
