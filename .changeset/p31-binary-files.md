---
"eharness": minor
---

Binary files and images in the filesystem plugin (P31 R9).

- **`FileSystem`** gains the optional `readBytes(path)` / `writeBytes(path, bytes, { ifVersion? })` and `FileMeta.binary` / `mediaType`. `memoryFs` (the seed may hold `Uint8Array`), `diskFs` (new `maxBinaryBytes`, default 10 MiB; `list`/`stat`/`glob` now show binary files, `grep` skips them; `read` of a binary file throws `binary file: <path> …`, of an oversized text file `too large file: <path> …`) and `mountFs` implement them; `checkpointedFs` passes them through. `fileSystemConformance` has `requireBytes`.
- **`read_file`** shows PNG, JPEG, GIF and WebP images to the model (a text line `Image <path> (<w>x<h>, <bytes> bytes, <mediaType>)` plus the image), PDFs with `media: { pdf: true }`; `filesystem({ media: { images?, pdf?, maxBytes? } })` (default images on, PDF off, 5 MiB). Other binaries answer `ERROR: binary file …; it cannot be shown as text.`; `write_file` and `edit_file` refuse binary files with an `ERROR:` text.
- The stored tool output is a small `{ type: 'media-ref', path, version, mediaType, bytes, text }` (no base64 in messages or storage); `toModelOutput` reads the bytes again when the history is projected and falls back to a text note when the file changed or was removed. `compaction.prune` prunes old images like any large output.
- New exports from `eharness/filesystem`: `detectMediaType`, `imageDimensions`, `looksBinary`, `bytesToBase64`, `bytesVersion`, `isFileMediaRef`, `FileMediaRef`, `BinaryFile`; from `eharness/filesystem/node`: `DEFAULT_MAX_BINARY_BYTES`.
