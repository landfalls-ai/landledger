# Tasks: The month-end package (spec 018)

- [x] Assemble
- [x] HTML
- [x] Zip and manifest
- [x] Console page
- [x] Tests

## Review of wave 4

- [x] R001 Should-fix 5: each lock round stores its package (`close_packages`); the manifest's sha256 in
  `close_locks` and the `period.locked` entry; a locked month is served the stored package.
- [x] R002 The journal, the roll-forward and the lock's signatures (with snapshots) in the package; CSV cells that
  start with `-` neutralised unless a plain number.
