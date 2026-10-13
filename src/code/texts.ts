/** Model-visible texts of the code plugin (internal wording: may change in a minor release, spec 28 §3). */

/**
 * Description of `run_python`; `{mounts}`, `{example}` (a script path in the first writable mount),
 * `{exampleRel}` (a data file relative to the root), `{timeout}` and `{maxTimeout}` are filled in.
 */
export const RUN_PYTHON_DESCRIPTION = `Run a Python script over the files of the shared file system and return its output and exit code.

- Write the script with write_file (for example {example}), then run it with \`file\`. Use \`code\` only for a short check; inline code is not saved.
- Synced folders: {mounts}. These files are copied into the sandbox before the run, and the files the script creates, changes or deletes are saved back to the file system after a successful run. If the run fails (non-zero exit code, timeout), nothing is saved.
- The script runs in the sandbox root: use relative paths without the leading slash (\`open("{exampleRel}")\`, not "/{exampleRel}").
- Do not rely on network access; packages cannot be installed from the script.
- No interactive input. Long output is truncated to the first and last part. A non-zero exit code is reported, not an error.
- Default timeout {timeout} s, at most {maxTimeout} s (timeoutSeconds).`

/** Description of `install_packages`. */
export const INSTALL_PACKAGES_DESCRIPTION = `Install extra Python packages for run_python. Give 1-20 requirement lines: a package name with an optional version specifier (for example "pandas-ta" or "scipy>=1.11"). Only wheels are installed; URLs, paths and options are not accepted. The packages can be imported in the next run_python call and stay installed for this workspace.`

/** The OS-sandbox denial hint (the same wording as the `bash` tool, spec 19 §2). */
export const SANDBOX_HINT =
  '(The command ran in the OS sandbox: writes outside the project and network access are blocked.)'

/** Matches the texts an OS sandbox produces when it denies an operation. */
export const SANDBOX_DENIAL: RegExp = /Operation not permitted|Read-only file system/i
