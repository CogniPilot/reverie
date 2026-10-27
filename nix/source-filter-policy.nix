# Packaging filter, never a deletion policy or an interpretation of .gitignore.
{ lib }:
relative: type:
let
  parts = lib.splitString "/" relative;
  generated = [
    "node_modules" "build" "dist" "target" "coverage" ".venv" ".direnv"
    "python/build" "python/dist" "python/.venv"
    "apps/web/node_modules" "apps/web/dist" "apps/web/coverage" "apps/web/.vite"
    "apps/web/packages/gesture-control/node_modules"
    "apps/web/packages/gesture-control/dist"
    "apps/web/packages/gesture-control/dist-reverie"
    "apps/web/packages/gesture-control/.vite"
  ];
  under = root: relative == root || lib.hasPrefix "${root}/" relative;
  metadata = builtins.any (part: builtins.elem part [ ".git" ".hg" ".svn" ]) parts;
  pythonCache = builtins.any (part: builtins.elem part [ "__pycache__" ".pytest_cache" ".mypy_cache" ".ruff_cache" ]) parts;
  rootResultLink = type == "symlink" && !(lib.hasInfix "/" relative)
    && (relative == "result" || lib.hasPrefix "result-" relative);
in !(metadata || pythonCache || rootResultLink || builtins.any under generated)
