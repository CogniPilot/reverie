# Import one declared build input without making its enclosing checkout a dependency.
src: relative: builtins.path { path = (src.origSrc or src) + "/${relative}"; }
