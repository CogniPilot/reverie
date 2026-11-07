# Explicit composition against a qualified already-built Console input. These
# are real separately imported TSC modules, never substitutions in index.js.
{ pkgs, src, console }:
let
  sourceFile = relative: builtins.path { path = (src.origSrc or src) + "/${relative}"; };
in pkgs.runCommand "reverie-memory-guest-modules" {
  nativeBuildInputs = [ pkgs.nodejs-slim_22 ];
} ''
  mkdir source
  cp ${sourceFile "apps/web/src/installed-memory-bridge.ts"} source/installed-memory-bridge.ts
  cp ${sourceFile "apps/web/src/installed-memory-origin.ts"} source/installed-memory-origin.ts
  cp ${sourceFile "apps/web/src/installed-memory-guest-origin.ts"} source/installed-memory-guest-origin.ts
  cp ${sourceFile "apps/web/package.json"} source/package.json
  ln -s ${console}/lib/reverie/node_modules node_modules
  node ${console}/lib/reverie/node_modules/typescript/bin/tsc \
    --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022 \
    --strict --esModuleInterop --skipLibCheck --forceConsistentCasingInFileNames \
    --resolveJsonModule --declaration --declarationMap --sourceMap \
    --noUnusedLocals --noUnusedParameters --noImplicitReturns --noImplicitOverride \
    --noFallthroughCasesInSwitch --allowUnreachableCode false --allowUnusedLabels false \
    --rootDir source --outDir compiled source/installed-memory-bridge.ts source/installed-memory-guest-origin.ts
  mkdir -p "$out"
  cp compiled/installed-memory-bridge.* "$out/"
  cp compiled/installed-memory-guest-origin.* "$out/"
  cp compiled/installed-memory-guest-origin.js "$out/installed-memory-origin.js"
''
