{ lib }:
let
  keep = import ../nix/source-filter-policy.nix { inherit lib; };
  checks = {
    gitDirectory = !(keep ".git" "directory");
    gitWorktreePointer = !(keep ".git" "regular");
    nestedGit = !(keep "nested/.git/config" "regular");
    hgMetadata = !(keep ".hg/store" "directory");
    webDependencies = !(keep "apps/web/node_modules/x/index.js" "regular");
    rootBuild = !(keep "build/x.o" "regular");
    pythonBuild = !(keep "python/build/lib/reverie.py" "regular");
    webDist = !(keep "apps/web/dist/index.js" "regular");
    gestureDist = !(keep "apps/web/packages/gesture-control/dist-reverie/index.js" "regular");
    pythonCache = !(keep "python/reverie/__pycache__/worker.pyc" "regular");
    resultLink = !(keep "result-image" "symlink");
    resultData = keep "result-data.json" "regular";
    nestedResult = keep "tests/fixtures/result-image" "symlink";
    fixtureBuild = keep "tests/fixtures/build/input.json" "regular";
    fixtureDist = keep "tests/fixtures/dist/input.json" "regular";
    similarlyNamed = keep "apps/web/dist-source/index.ts" "regular";
    githubCI = keep ".github/ci/boot-owner.sh" "regular";
    gitignore = keep ".gitignore" "regular";
    model = keep "apps/web/src/web/public/gesture/gesture_recognizer.task" "regular";
    wasm = keep "apps/web/src/web/public/gesture/wasm/vision_wasm_internal.wasm" "regular";
    vendor = keep "apps/web/src/web/public/vendor/rumoca/parser.js" "regular";
    source = keep "python/reverie/worker.py" "regular";
    lock = keep "apps/web/package-lock.json" "regular";
    skillLink = keep "skills/reverie/assets/linked-tool" "symlink";
    fixtures = keep "apps/web/test/fixtures/recovery-ledger/state.json" "regular";
  };
in assert builtins.all (x: x) (builtins.attrValues checks); checks
