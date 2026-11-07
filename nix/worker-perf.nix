# Keep stat/record/report without perf's embedded Python and runtime scripts.
# Python remains a third-party build dependency of upstream perf's generators.
{ pkgs }:
pkgs.perf.override { withPython = false; }
