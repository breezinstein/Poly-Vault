# Patch stack

`0001`–`0007` are the upstream-facing changes (core scanner/bridge, Unity add-on,
renderer hooks) as they were applied to
[`xeeshanqaswar/Poly-Vault`](https://github.com/xeeshanqaswar/Poly-Vault) at tag
**v0.4.2**. They are already **applied**, and they remain the reference for
rebasing onto a newer upstream release.

The web shell (`server/`, Docker, docs, ops scripts) is this fork's own code and
is not part of the patch stack; later UI work landed directly in `ui/`. To see
everything the fork changes relative to upstream in one file:

```bash
./scripts/export-upstream-diff.sh        # -> dist/poly-vault-vs-upstream.patch
```

## Review a single change

```bash
git show <commit>          # each patch was committed on its own
```

## Rebase onto a newer upstream release

```bash
git remote add upstream https://github.com/xeeshanqaswar/Poly-Vault.git
git fetch upstream --tags
git switch -c rebase/upstream-v0.4.3 upstream/v0.4.3
for p in patches/*.patch; do git apply --3way "$p" || echo "conflict: $p"; done
```

Then re-run the suites (`./scripts/verify-phase2.sh`, `verify-phase3.sh`,
`verify-ui.sh`) and the browser check before tagging.

| Patch | Area |
| --- | --- |
| 0001 | web shell enablers, injectable scanner, symlink/path safety |
| 0002 | per-artist import jobs, HTTP download in the Unity add-on |
| 0003 | thumbnails requested from the host |
| 0004 | one asset per `.unitypackage` (Asset Store cache layout) |
| 0005 | asynchronous scanner (off-thread walks) |
| 0006 | "What's inside" panel for packages |
| 0007 | Unity window: read `EditorPrefs` in `OnEnable` |
