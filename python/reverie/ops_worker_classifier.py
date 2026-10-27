"""Mechanically exported exact reviewed WorkerBroker.inspect_container; never edit its grammar here."""
import json,re
def inspect_container(self, name):
        """A transient or malformed engine reply is unknown, never stopped."""
        result = self.run_engine(['inspect', name], optional=True)
        if result.returncode:
            missing = {
                'Error: No such object: ' + name,
                'Error: no such object: "' + name + '"',
                'Error: inspecting object: no such object: "' + name + '"',
            }
            if (result.returncode not in (1, 125) or result.stderr.strip() not in missing or
                    result.stdout.strip() not in ('', '[]')):
                raise RuntimeError('Worker container state is unavailable')
            # Generic inspect can search several object types. Confirm absence
            # with a successful container inventory, including stopped laptops.
            inventory = self.run_engine(['ps', '--all', '--format', '{{.Names}}'])
            names = inventory.stdout.splitlines()
            if (inventory.returncode or len(names) != len(set(names)) or
                    any(not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', value) for value in names) or
                    name in names):
                raise RuntimeError('Worker container state is unavailable')
            return {'State': {'Running': False}}
        try:
            items = json.loads(result.stdout)
            if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
                raise ValueError
            item = items[0]
            if not isinstance(item.get('State'), dict) or type(item['State'].get('Running')) is not bool:
                raise ValueError
        except (ValueError, TypeError):
            raise RuntimeError('Worker container state is unavailable') from None
        return item
