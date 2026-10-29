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
  mkdir -p "$out/python/reverie" "$out/share/systemd/user"
  cp ${src}/tests/fixtures/transport-startup-broker.py "$out/python/reverie/worker.py"
  cat > "$out/bin/reverie-worker-broker" <<EOF
  #!${pkgs.runtimeShell}
  exec $out/bin/python3 -I -B $out/python/reverie/worker.py broker "\$@"
  EOF
  cat > "$out/bin/reverie-worker-service-check" <<EOF
  #!${pkgs.runtimeShell}
  exit 0
  EOF
  cat > "$out/share/systemd/user/reverie-worker-broker.service" <<'UNIT'
  [Unit]
  Description=Reverie laptop broker and office watchdog
  [Service]
  EnvironmentFile=%h/.config/reverie/worker-broker.env
  ExecStartPre=@root@/bin/reverie-worker-service-check --config ''${REVERIE_WORKER_CONFIG}
  ExecStart=@root@/bin/reverie-worker-broker --config ''${REVERIE_WORKER_CONFIG}
  Restart=on-failure
  RestartSec=3
  TimeoutStopSec=35
  KillMode=mixed
  UMask=0077
  NoNewPrivileges=true
  MemoryMax=512M
  TasksMax=512
  [Install]
  WantedBy=default.target
  UNIT
  substituteInPlace "$out/share/systemd/user/reverie-worker-broker.service" \
    --replace-fail '@root@' "$out"
  chmod 0555 "$out/bin/reverie-worker-broker" "$out/bin/reverie-worker-service-check"
''
