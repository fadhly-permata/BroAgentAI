# Multi-root path semantics

The bridge registers every workspace as a root with a stable root id. `root.list`, `root.setActive` and `root.remove` manage the registry; the existing `workspace.*` methods remain supported and operate on the active root.

`resolveRootPath` accepts either a plain workspace-relative path (resolved against the active root) or an explicit `@rootId:relative/path`. Filesystem and search RPCs use this resolver, and results from a non-active root are returned with the `@rootId:` prefix so they can be passed back unchanged.

Limitation: the side panel explorer and editor tabs still operate on the active root only. They can list roots, switch the active root and open `@rootId:` paths returned by the bridge, but they do not render a simultaneous multi-root tree or persist per-root tab state. Git operations also remain bound to the active root: a workspace must be the repository root, so a root-qualified Git path is not accepted. This keeps single-root `fs`/`git` semantics unchanged while the registry and resolver are additive.
