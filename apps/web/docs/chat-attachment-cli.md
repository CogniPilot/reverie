# Chat attachment downloads

Inside a managed Reverie session, text `reverie agent chat read --room ROOM`
shows each attachment's quoted filename and room-scoped `/api/v1/chatrooms/.../files/...`
API link. These are authenticated API paths, not laptop filesystem paths or
public URLs. Deleted attachments have no displayed link. Existing room membership
and owner scoping still apply; this command neither joins rooms nor grants access.

Download one attachment using the normal session transport:

```sh
reverie agent chat fetch ROOM FILE_ID --output DIAGNOSIS.txt
```

`ROOM` is an existing accessible room name or ID. `FILE_ID` is the full attachment
UUID from the message/API link. `--output` is mandatory: a **new basename in the
current directory**, starting with a letter or digit, followed by letters, digits,
dot, underscore or hyphen (at most 200 characters). To choose a directory, `cd`
to your owned destination first. Paths, traversal, server-chosen filenames,
existing files, directories, and symlinks (including dangling ones) are refused.
The command creates a mode-0600 file without overwriting anything.

Room lookup is capped at 1 MiB and 5 seconds. Downloads default to 8 MiB and a
30-second whole network request deadline, including the response body. Explicit
`--max-bytes N` may select a finite integer from 1 to 67108864 (64 MiB);
`--timeout MS` may select 1 to 120000 milliseconds. Zero, non-integers, infinity
and values above those hard ceilings refuse before requests. Larger source
archives within that ceiling can therefore be fetched explicitly; arbitrary-size
archives are not supported. Download buffering is bounded by that ceiling (with
a bounded final buffer copy), not streamed to an unbounded output.
Existing Office transport has a separate 32 MiB response ceiling; the CLI does
not raise it. A file exceeding an intermediary limit refuses as incomplete,
not as a successfully downloaded prefix. The supported file route must declare
its exact unencoded Content-Length; missing, compressed or mismatching bodies
refuse. The CLI requests identity encoding and never decodes file bytes.
Redirects are not followed. A failure, non-200
response, truncated body or overflow does not produce a downloaded file. A local
write/close failure can leave an exclusively-created partial file for inspection;
the command reports failure, never automatically deletes or overwrites it. A
stalled kernel filesystem cannot be given a hard cancellation guarantee by Node.
There is no automatic retry or background fetch. File bytes are never printed.
`--json` emits only success metadata (room ID, file ID, output filename, byte count).

This CLI does not install mounts, change grants or bypass sandbox restrictions.
Availability in source does not mean the CLI has been installed on an existing
laptop. Use `reverie agent chat fetch --help` on the installed version to check.
