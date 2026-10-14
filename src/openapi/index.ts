/**
 * `eharness/openapi`: OpenAPI 3.0 / 3.1 operations as agent tools.
 *
 * **Deprecated** (ADR-0062): no product built on eharness uses this module; it is removed at 1.0
 * unless one adopts it.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/17-openapi-plugin.md
 */
export {
  type OpenApiSourceOptions,
  type OperationFilter,
  type OperationInfo,
  openApiSource,
} from './source.ts'
