# Chat images on laptops

`reverie agent chat read` automatically requests a local copy of supported image
attachments for the current laptop. Exact-message reads do the same. The text
output shows the local path; JSON output adds `localPath` and
`localImageStatus: "ready"` to the attachment. Use that path with the harness's
normal image-viewing tool. No manual download command or image opt-in is needed.

Copies are available only to a live employee laptop whose identity, storage and
attachment isolation can be verified. Room membership and the exact message's
attachment reference are checked through that laptop's existing authenticated
Office connection. A room read grants no new membership or file permissions.

PNG, JPEG, GIF and WebP are supported. Each copy is limited to 8 MiB; a message
request is limited to four images and 16 MiB. One history read attempts copies for
at most four messages. Images beyond those limits can be requested with a later
exact-message read. SVG and other file types keep their ordinary attachment flow.

If a copy cannot be made, the message remains readable and says that the local
image is unavailable. JSON has `localImageStatus: "unavailable"`; a server-side
image storage path is never presented as a laptop path. Re-read the exact
message to request a fresh copy after the laptop or authorization is available.

The broker reaps active-cache copies after 30 minutes while running and
reconciles recorded current-cache copies when it restarts. Copies retained with
old scratch storage follow that storage's cleanup lifecycle. Paths are temporary: re-read rather than saving
a path in a long-lived task. Copies made elsewhere and information already read
are outside this cache's lifecycle.

Queued pane delivery prepares image paths when the queue is flushed, rather
than saving paths with the message. Automatic image-path delivery uses the
verified Codex and Claude Code composer guards. Other harnesses can obtain the
same copies through their ordinary chat read, without a pane write.
