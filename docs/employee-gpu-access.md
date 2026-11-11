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
binding CAS, so refresh after a binding change. Running laptops keep their
current policy while the request is pending. When status offers **Apply saved
request**, the owner can apply the selected revision while that laptop is
stopped. The protected broker checks the saved request, current binding and host
state, then updates the configuration and its actor binding. Start the laptop
normally when ready. Legacy overrides, unsettled work, missing native facts or
an installed protected terminal may require operator maintenance.

The standard server selects its existing `REVERIE_WORKER_SOCKET`. The installed
website resource channel verifies the current owner and employee binding for
status, saving a request, and applying that saved revision. No Docker socket
or host configuration path is exposed to the browser. An older broker that
supports GPU status and requests can still show and save those facts. Apply
appears only after the separate, current native readiness read. Refresh status
after saving to check availability. Refresh also lets you inspect an unconfirmed
request before deciding whether to act again.

This source feature requires the matching reviewed broker generation and GUI
build. Source/unit checks do not install the backend or prove native device
access. Native activation, image/CDI custody and an owner-approved harmless
canary remain separate checks; scientific work is not authorized by a setting.
