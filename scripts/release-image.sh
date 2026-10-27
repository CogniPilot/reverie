#!/usr/bin/env bash
# CI artifact contract only; never logs in, pushes, rebuilds or starts an instance.
set -euo pipefail
directory=$(cd -- "$(dirname -- "$0")" && pwd)
fail() { echo "Release image contract: $*" >&2; exit 1; }
validate() {
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-ci)?$ ]] || fail 'invalid version'
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid commit'
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'invalid immutable image ID'
}
field() {
  local value
  value=$(sed -n "s/^$1: //p" "$bundle/IMAGE-REF.txt")
  [[ -n "$value" && "$value" != *$'\n'* ]] || fail "missing or duplicate $1"
  printf '%s' "$value"
}
case "${1:-}" in
  metadata)
    [ "$#" = 5 ] || fail 'metadata expects owner, version, commit, image ID'
    repository=$(bash "$directory/setup.sh" --print-image-repository "$2")
    version=$3 commit=$4 image_id=$5
    validate
    printf 'Version: %s\nCommit: %s\nImage-ID: %s\nRepository: %s\nTags: %s:latest %s:%s\n' \
      "$version" "$commit" "$image_id" "$repository" "$repository" "$repository" "$version"
    ;;
  load)
    [ "$#" = 6 ] || fail 'load expects engine, bundle, owner, version, commit'
    engine=$2 bundle=$3
    repository=$(bash "$directory/setup.sh" --print-image-repository "$4")
    version=$5 commit=$6 image_id=$(field Image-ID)
    validate
    [ "$(field Version)" = "$version" ] || fail 'version mismatch'
    [ "$(field Commit)" = "$commit" ] || fail 'commit mismatch'
    [ "$(field Repository)" = "$repository" ] || fail 'repository mismatch'
    [ "$(field Tags)" = "$repository:latest $repository:$version" ] || fail 'tag inventory mismatch'
    # These CI consumers require a clean store for this exact immutable ID.
    # Otherwise a different archive could be mistaken for cached expected bytes.
    inventory=$("$engine" image ls --all --quiet --no-trunc)
    count=0
    while IFS= read -r cached; do
      [ -n "$cached" ] || continue
      count=$((count+1))
      [[ "$count" -le 4096 && "$cached" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'unqualified image inventory'
      [ "$cached" != "$image_id" ] || fail 'expected image ID already present; clean-loader precondition refused'
    done <<< "$inventory"
    "$engine" load --input "$bundle/reverie-image.tar" >&2
    # A clean daemon need not have any required name before these explicit
    # aliases. Verify loaded bytes by immutable ID before inspecting a name.
    actual=$("$engine" image inspect --format '{{.Id}}' "$image_id")
    [ "$actual" = "$image_id" ] || fail 'loaded immutable image mismatch'
    for reference in "$repository:latest" "$repository:$version"; do
      "$engine" tag "$image_id" "$reference"
      [ "$("$engine" image inspect --format '{{.Id}}' "$reference")" = "$image_id" ] || fail 'alias mismatch'
    done
    printf '%s\n' "$image_id"
    ;;
  *) fail 'expected metadata or load' ;;
esac
