/**
 * eharness core API.
 *
 * Every public symbol is re-exported here explicitly (no `export *`). Subpath modules
 * (`eharness/filesystem`, `eharness/testing`, …) import core only through this file.
 *
 * @see docs/architecture.md#2-package--exports
 */

export {
  HarnessError,
  type HarnessErrorCode,
  type HarnessErrorOptions,
  type HarnessNoticeCode,
  HarnessToolError,
  type HarnessWarning,
  isHarnessError,
  type WarningCode,
} from './errors.ts'

export { isUuidV7, uuidv7 } from './messages/ids.ts'

/** Package version of this build. */
export const version: string = '0.0.2'
