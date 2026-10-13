/**
 * Helper scripts of the code plugin (internal). They are written into the sandbox under
 * `.eh-code/` and run with the sandbox's Python. Python 3.6+ standard library only.
 *
 * @see docs/specs/28-code-plugin.md
 */

/** Directory of the helper files, relative to the sandbox root (reserved, never synced). */
export const CODE_DIR: string = '.eh-code'
/** Path of the listing helper. */
export const LIST_SCRIPT_PATH: string = `${CODE_DIR}/list.py`
/** Path of the listing helper's arguments (JSON, written before each listing). */
export const LIST_ARGS_PATH: string = `${CODE_DIR}/list-args.json`
/** Path of the marker file (§4.5). */
export const MARKER_PATH: string = `${CODE_DIR}/marker`
/** Path of the inline script of `run_python({ code })`. */
export const INLINE_SCRIPT_PATH: string = `${CODE_DIR}/inline.py`
/** `HOME` of a run, relative to the sandbox root. */
export const HOME_DIR: string = `${CODE_DIR}/home`

/**
 * Lists regular files (symlinks skipped) under the directories of the JSON file given as the
 * first argument: `{ dirs: string[], ignore: string[] (regex sources over the relative path), only?: string[] }`.
 * Prints one JSON array of `{ path, size, sha1 }`, paths relative to the current directory.
 */
export const LIST_SCRIPT = `import hashlib, json, os, re, sys

cfg = json.load(open(sys.argv[1]))
ignore = [re.compile(p) for p in cfg.get("ignore", [])]
only = cfg.get("only")


def skipped(rel):
    if rel == ".eh-code" or rel.startswith(".eh-code/"):
        return True
    return any(r.search(rel) for r in ignore)


def entry(rel):
    try:
        if os.path.islink(rel) or not os.path.isfile(rel):
            return None
        h = hashlib.sha1()
        with open(rel, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return {"path": rel, "size": os.path.getsize(rel), "sha1": h.hexdigest()}
    except OSError:
        return None


out = []
if only is not None:
    for rel in only:
        if not skipped(rel):
            e = entry(rel)
            if e:
                out.append(e)
else:
    for d in cfg.get("dirs", ["."]):
        if not os.path.isdir(d) or os.path.islink(d):
            continue
        for root, dirnames, filenames in os.walk(d, followlinks=False):
            dirnames[:] = [n for n in dirnames if not os.path.islink(os.path.join(root, n))]
            for name in filenames:
                rel = os.path.normpath(os.path.join(root, name)).replace(os.sep, "/")
                if skipped(rel):
                    continue
                e = entry(rel)
                if e:
                    out.append(e)
sys.stdout.write(json.dumps(out))
`

/** Prints the interpreter version and the installed distributions as JSON. */
export const PROBE_SCRIPT = `import json, sys
from importlib import metadata
seen = {}
for d in metadata.distributions():
    name = d.metadata["Name"]
    if name:
        seen[name.lower()] = [name, d.version]
print(json.dumps({"version": "%d.%d.%d" % sys.version_info[:3], "packages": sorted(seen.values(), key=lambda p: p[0].lower())}))
`

/** Prints the interpreter version. */
export const VERSION_SCRIPT = 'import sys;print("%d.%d.%d" % sys.version_info[:3])'

/** Prints the purelib directory of the interpreter. */
export const PURELIB_SCRIPT = 'import sysconfig;print(sysconfig.get_paths()["purelib"])'
