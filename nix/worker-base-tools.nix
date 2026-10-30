# Laptop base-tool layer (roadmap T3), included on the worker image's PATH.
# Every attribute below was checked to exist at the laptops' pinned nixpkgs a033e66ab94a6bedf2c3d58d93a36319d3cbbbaf.
# Commands each package provides are in the comments, and probe.sh checks every one of them.
{ pkgs }:
with pkgs; [
  util-linux      # lsblk findmnt mount umount taskset lscpu ionice column setsid more hexdump
  procps          # ps top free pgrep pkill watch
  psmisc          # fuser killall pstree
  lsof            # lsof
  file            # file
  less            # less
  tree            # tree
  unzip zip xz zstd bzip2 p7zip   # unzip zip xz zstd bzip2 7z
  gnupatch        # patch
  gettext         # envsubst
  bc              # bc
  iproute2        # ip ss
  iputils         # ping
  dnsutils        # dig nslookup host
  netcat-openbsd  # nc
  wget            # wget
  openssl         # openssl
  openssh         # ssh scp
  rsync           # rsync
  strace          # strace
  gdb             # gdb
  cmake ninja pkg-config   # cmake ninja pkg-config
  perl            # perl
  man-db          # man
  ncurses         # tput clear
  vim nano        # vim vi nano
  xxd             # xxd
  sqlite          # sqlite3
  time            # time (GNU /usr/bin/time-style, as `time` on PATH; the shell builtin still wins in bash)
  tzdata          # with TZDIR=${tzdata}/share/zoneinfo in the launcher env, so TZ= works
  numactl         # numactl
  hostname-debian # hostname
]
# Not included, on purpose:
# - pip/pip3: Nix's python3 is immutable. `python3 -m venv .venv && .venv/bin/pip` works today (tested), so ship a
#   one-line hint instead (see README).
# - libudev, project toolchains and wasm tools: they belong in each repo's flake dev shell, not the base layer.
