# Public inert own-child regression. No broker, engine or instance is invoked.
{ pkgs, src }:
pkgs.runCommand "reverie-interpreter-exec-window-fixture" {
  nativeBuildInputs = [ pkgs.stdenv.cc ];
} ''
  mkdir -p "$out/bin"
  $CC -std=c11 -Wall -Wextra -Werror -O2 \
    -DREAL_PYTHON='"${pkgs.python3}/bin/python3"' \
    ${src}/tests/fixtures/interpreter-exec-window.c -o "$out/bin/python3"
  chmod 0555 "$out/bin/python3"
''
