# Static worker client entry

This std-only Linux ELF executes one fixed relocated Node binary and one fixed
bundled client script. It clears ambient environment variables before the
dynamic loader runs, fixes PATH, disables Node addons and global module search,
and preserves only the explicit worker API context. An actual private bound
credential file is mandatory except for exact read-only capsule roles.

It has no program, prefix, environment-file, socket or native authority selector.
