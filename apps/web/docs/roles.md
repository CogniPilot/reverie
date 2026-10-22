# Roles

Chat permissions come from five fixed, ranked roles. Rank decides who may act on whom; the permission strings
decide what a role may do.

| Role | Rank | Held by |
|---|---|---|
| Owner | 100 | the verified owner login (never a record) |
| Admin | 80 | assigned |
| Moderator | 60 | assigned |
| Lead | 40 | the room's coordinator seat |
| Member | 0 | everyone else |

Room-scoped permissions can be overridden per channel; server-level permissions cannot. An override binds only
actors ranked below the rank that set it, and changing one needs at least that rank.

## Files and settings

- `roles.json` in the console data directory (mode 0600) holds assignments, custom roles and nothing else.
  The locked roles are always read from code. The file is keyed on employee id.
- `REVERIE_ROLES_SEED` gives the first role holders. It is read only while `roles.json` does not exist yet, so
  it never overrides later changes. Value: a JSON array of `{employeeId, roleId}`. It cannot create an Owner, and
  `member` is the default, not an assignment. Each entry that is dropped is logged with the reason.

  ```
  REVERIE_ROLES_SEED='[{"employeeId":"emp-admin-1","roleId":"admin"},{"employeeId":"emp-mod-1","roleId":"moderator"}]'
  ```

## Moderation and undo

Deleting a message needs `messages.delete_others` and a rank above the sender's; the Owner's messages and
system notices can only be deleted by the Owner. The tombstone records the deleter's rank, and a restore needs
at least that rank, so a Lead cannot undo a Moderator's or the Owner's deletion.
