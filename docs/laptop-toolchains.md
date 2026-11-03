# Laptop toolchains

The laptop image includes Rust and Cargo, GCC, pytest, GitHub CLI, jq,
diffutils and fd. Project-specific dependencies still belong in the project's
development environment.

The laptop's `python`, `python3` and versioned Python command use a private
interpreter with immutable GCC runtime and zlib library search paths. This
lets binary extensions that do not set their own `DT_RUNPATH`, such as
NumPy's manylinux wheels, find those common libraries without setting
`LD_LIBRARY_PATH`. An extension that sets `DT_RUNPATH` searches only that
path and is not helped. The `pytest` and `py.test` commands use the same interpreter.
New virtual environments inherit it:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install PACKAGE
```

Packages may require additional native libraries beyond GCC and zlib. Those
dependencies still need a suitable project environment; this does not make
every binary wheel self-contained.

The website and broker interpreters are unchanged. This image change does not
modify an existing laptop or virtual environment. Updating deployed laptops
requires the normal reviewed image rollout; recreate a virtual environment
when it still points to the previous interpreter.

The `workerPythonRuntime` flake check loads an extension with C++ and zlib
dependencies through Python, a new venv and both pytest commands, without
library-path or preload environment overrides.
