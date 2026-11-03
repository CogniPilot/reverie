# Facts only: exact immutable Node and complete console package graph, no owner grant.
{ pkgs, src, console, ownerTerminalProgram ? null }:
pkgs.runCommand "reverie-worker-resume-program" { nativeBuildInputs = [ pkgs.python3 ]; } ''
  python3 -I -B ${src}/python/reverie/worker_resume_program.py --nix-build-inputs \
    --console ${console} --node ${pkgs.nodejs_22}/bin/node${pkgs.lib.optionalString (ownerTerminalProgram != null) " --owner-terminal-program ${pkgs.lib.escapeShellArg ownerTerminalProgram}"} \
    --output "$out/share/reverie/worker-resume-program.json"
''
