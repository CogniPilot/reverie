# Optional Nix profile, never part of the lean worker runtime/image closure.
{ pkgs, src }:
pkgs.runCommand "reverie-worker-docker" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  meta.mainProgram = "dockerd-rootless";
} ''
  mkdir -p "$out/bin" "$out/libexec/docker"
  moby=$(dirname "$(dirname "$(readlink -f ${pkgs.docker}/bin/dockerd)")")
  test -x "$moby/libexec/docker/dockerd"
  test -x "$moby/libexec/docker/runc"
  for path in "$moby"/libexec/docker/*; do
    ln -s "$path" "$out/libexec/docker/$(basename "$path")"
  done
  rm "$out/libexec/docker/runc"
  substitute ${src}/scripts/reverie-rootless-runc "$out/libexec/docker/runc" \
    --replace-fail '@RUNC@' "$(readlink -f "$moby/libexec/docker/runc")"
  chmod 0555 "$out/libexec/docker/runc"
  patchShebangs "$out/libexec/docker/runc"
  # Bypass the original PATH-prefixing daemon wrapper so BuildKit cannot select
  # the unwrapped runc and start an unnamespaced session keyring.
  rm "$out/libexec/docker/dockerd"
  ln -s "$moby/libexec/docker/dockerd" "$out/libexec/docker/dockerd"
  makeWrapper ${pkgs.bash}/bin/bash "$out/bin/dockerd-rootless" \
    --add-flags "$moby/libexec/docker/dockerd-rootless.sh --storage-driver=vfs" \
    --set DOCKERD "$out/libexec/docker/dockerd" \
    --set DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS false \
    --prefix PATH : "$out/libexec/docker:/bin:${pkgs.lib.makeBinPath [ pkgs.rootlesskit pkgs.slirp4netns pkgs.iproute2 pkgs.iptables pkgs.nftables pkgs.procps pkgs.util-linuxMinimal pkgs.coreutils pkgs.gnugrep ]}"
  ln -s ${pkgs.docker}/bin/docker "$out/bin/docker"
''
