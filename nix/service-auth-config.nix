# A guest path is data. Never accept a Nix path and import a private file.
{ lib }:
value:
assert value == null || (builtins.isString value
  && builtins.stringLength value > 1 && builtins.stringLength value <= 4096
  && lib.hasPrefix "/" value && !(lib.hasPrefix "//" value)
  && !(lib.hasSuffix "/" value) && !(lib.hasInfix "//" value)
  && builtins.match ".*[[:cntrl:]].*" value == null
  && builtins.all (part: part != "." && part != "..") (lib.splitString "/" value));
value
