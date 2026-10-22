# Reverie installation and updates

Install Nix, clone the Reverie monorepo, and run from its root:

```sh
git clone https://github.com/jgoppert/reverie.git
cd reverie
nix profile add .#default
reverie web
```

The default package includes the company dashboard, console, runtime and tools.
No NixOS module or system configuration change is required. Installation does not
activate a service. Follow the [root README](../../../../README.md) for authentication,
persistent data and container startup.

Update the checkout, review the changes, and run the same profile command.
Build the container image with:

```sh
nix build .#dockerImage
```

The imported upstream self-updater and npm publication process are not used.
