# Reverie image

The image uses the same full application derivation as `nix build .#default`.
Build and load it with:

```sh
mkdir -p "$HOME/scratch/reverie/build"
nix build .#dockerImage --out-link "$HOME/scratch/reverie/build/docker-image"
podman load --input "$HOME/scratch/reverie/build/docker-image"
```

That build runs every package's test suite. `nix build .#unchecked.dockerImage`
builds the same image without them; see
[building without the test suites](../docs/manual.md#building-without-the-test-suites-and-running-them-separately)
for the separate verification command and what it means for image IDs.

The resulting image is `reverie:latest`. `scripts/reverie-container build` builds,
loads and tags it for the development launcher. There is no separate Containerfile
build or application dependency installation in the image path.
