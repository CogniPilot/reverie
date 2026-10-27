# Module-only root acceptance entry point. No activation, root policy or live cleanup.
{ pkgs, src, initializer, peerArtifact ? import ./lease-peer-static.nix { inherit pkgs src; } }:
pkgs.runCommand "reverie-lease-acceptance" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  passthru.peerArtifactPath = "${peerArtifact}/bin/reverie-acceptance-peer";
  meta = {
    description = "Module-managed host/laptop inode and kernel-lock acceptance";
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-prune-acceptance";
  };
} ''
  mkdir -p "$out/libexec/reverie" "$out/bin"
  for name in acceptance acceptance_io peer_port peer_helper peer_artifact host_install; do
    install -m444 "${src}/python/reverie/cleanup/$name.py" "$out/libexec/reverie/$name.py"
  done
  # Flat acceptance imports use the same fixed resource/storage implementation.
  for name in worker_resources worker_storage; do
    install -m444 "${src}/python/reverie/$name.py" "$out/libexec/$name.py"
  done
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune-acceptance" \
    --add-flags "-I -B $out/libexec/reverie/acceptance.py" \
    --add-flags "--initializer ${initializer}/bin/reverie-prune-declared --docker ${pkgs.docker-client}/bin/docker --peer-binary ${peerArtifact}/bin/reverie-acceptance-peer"
  "$out/bin/reverie-prune-acceptance" --help >/dev/null
  chmod -R a-w "$out"
''
