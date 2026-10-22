# Nix-built Docker deployment

The standalone console Docker/Compose setup has been removed. Reverie has one
image build path: the repository root flake's `.#dockerImage`, using the same
complete runtime as the native package.

See the root [installation guide](../../../README.md#setup) and
[operations guide](../../../docs/setup.md). Persistent instance and agent-home
storage remain outside the image. In-app npm updates cannot replace an immutable
Nix runtime. If the owner enables the fixed host updater, agents edit the mounted
source and run `reverie-request-update`; the container needs no Docker socket.
