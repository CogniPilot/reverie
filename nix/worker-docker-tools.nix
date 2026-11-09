# Optional Nix profile, never part of the lean worker runtime/image closure.
{ pkgs, src }:
let
  # Only replace the four already-selected reproducibility patches whose
  # upstream HTTP endpoints now return an Anubis HTML challenge. The same
  # full Git commits are vendored; all other patches remain unchanged.
  replacements = {
    "0001-build-fix-.-configure-with-non-bash-shell.patch" = "0001-non-bash-configure.patch";
    "0002-build-simplify-the-instantation-of-nftversion.h.patch" = "0002-nftversion-template.patch";
    "0003-build-generate-build-time-stamp-once-at-configure.patch" = "0003-configure-build-timestamp.patch";
    "0004-build-support-SOURCE_DATE_EPOCH-for-build-time-stamp.patch" = "0004-source-date-epoch.patch";
  };
  nftables = pkgs.nftables.overrideAttrs (previous:
    assert previous.version == "1.1.6";
    assert builtins.all (name:
      builtins.length (builtins.filter (patch: patch.name == name) previous.patches) == 1
    ) (builtins.attrNames replacements);
    {
      patches = map (patch:
        if builtins.hasAttr patch.name replacements
        then src + "/nix/patches/nftables/${replacements.${patch.name}}"
        else patch
      ) previous.patches;
    });
  docker = pkgs.docker.override { inherit nftables; };
in
pkgs.runCommand "reverie-worker-docker" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  meta.mainProgram = "dockerd-rootless";
} ''
  mkdir -p "$out/bin" "$out/libexec/docker"
  moby=$(dirname "$(dirname "$(readlink -f ${docker}/bin/dockerd)")")
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
    --prefix PATH : "$out/libexec/docker:/bin:${pkgs.lib.makeBinPath [ pkgs.rootlesskit pkgs.slirp4netns pkgs.iproute2 pkgs.iptables nftables pkgs.procps pkgs.util-linuxMinimal pkgs.coreutils pkgs.gnugrep ]}"
  ln -s ${docker}/bin/docker "$out/bin/docker"
''
