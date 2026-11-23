# Mesh2Motion patches

Applied in filename order by the `rig` stage of the Dockerfile, on top of the
pinned upstream commit (`M2M_COMMIT`). Each patch is a plain `git diff` against
that commit. To refresh after bumping the commit: check out upstream at the new
commit, `git apply` each patch, fix conflicts, and regenerate with `git diff`.
