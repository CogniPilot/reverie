# Employee GPU access


In an expert profile, open **Permissions → Laptop GPU access**. The owner can
choose an exact GPU reported by the fixed host backend and save an explicit
request. This uses the native EID request store; it does not turn a company
checkbox into a device grant. Agents and service tokens cannot use this owner
setting. Requests contain no host paths, engine flags or commands.

The profile shows **Requested**, **Host policy**, and **Active device access**
separately. An existing legacy session grant remains selected when no explicit
request exists. Unknown observations stay unknown, and an unrelated **Save
profile** never submits a GPU change. Access is shared and reserves no VRAM.

Saving never stops or restarts a provider, wakes an employee, changes a plan,
or runs GPU computation. Applied grants follow the stable employee ID across
approved session replacements; pending requests still require the current
binding CAS, so refresh after a binding change. Running laptops keep their current policy while the
request is pending. Only the fixed host handler may apply a stopped, idle,
currently bound employee request; the next authorized normal recreation uses
the verified policy. Legacy overrides, retained work, missing native facts or
an installed protected consumer needing a config rebind can require coordinated
operator maintenance. They are not bypassed by the GUI.

The standard server selects its existing `REVERIE_WORKER_SOCKET`. The fixed C
control protocol supplies bounded status and request replies. No Docker socket
or host configuration path is exposed to the browser. A missing or older host
backend reports unavailable; the GUI does not claim that access is off, applied,
or active. An unconfirmed request is never retried automatically: refresh the
native status before making another request.

This source feature requires the matching reviewed broker generation and GUI
build. Source/unit checks do not install the backend or prove native device
access. Native activation, image/CDI custody and an owner-approved harmless
canary remain separate checks; scientific work is not authorized by a setting.
