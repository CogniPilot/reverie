{ pkgs, src }:
let
  payload = pkgs.runCommand "reverie-launch-guard-payload" { } ''
    mkdir -p "$out/python/reverie" "$out/share"
    cp ${src}/python/reverie/__init__.py "$out/python/reverie/"
    cp ${src}/python/reverie/launch_guard.py "$out/python/reverie/"
    cp ${src}/examples/launch-guard-input.json "$out/share/example.json"
    cp ${src}/schemas/launch-guard-receipt-v1.json "$out/share/receipt-schema.json"
  '';
in pkgs.writeShellApplication {
  name = "reverie-launch-guard";
  text = ''
    case "''${1:-}" in
      --help)
        if [ "$#" -ne 1 ]; then exit 2; fi
        printf '%s\n' 'Usage: reverie-launch-guard [--help|--example]' 'Read bounded fixture JSON from stdin; emit a SYNTHETIC receipt. No live adapter or automatic blocking.'
        exit 0
        ;;
      --example)
        if [ "$#" -ne 1 ]; then exit 2; fi
        exec ${pkgs.coreutils}/bin/cat ${payload}/share/example.json
        ;;
      "")
        if [ "$#" -ne 0 ]; then exit 2; fi
        ;;
      *) printf '%s\n' 'Unsupported argument' >&2; exit 2 ;;
    esac
    exec ${pkgs.python3}/bin/python3 -I -B -c 'import sys; sys.path.insert(0, "${payload}/python"); from reverie.launch_guard import main; sys.exit(main())'
  '';
}
