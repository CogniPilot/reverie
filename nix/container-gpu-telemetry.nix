# Private in-container GPU telemetry, selected only by the GPU image producer.
{ pkgs, src }:
pkgs.writeShellApplication {
  name = "reverie-container-gpu-telemetry";
  runtimeInputs = [ pkgs.nodejs_22 ];
  text = ''exec node --experimental-strip-types ${src}/apps/container/gpu-telemetry.ts "$@"'';
}
