/** Shared stored-reference wire metadata and the Native projection of the result capability. */
import type { JsonSchemaNode } from '../adapter/dsh/types.js'
import type { ParameterSchema } from './types.js'
const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
export const STORAGE_REFERENCE: JsonSchemaNode = {
  type: 'object', properties: {
    refId: { ...string, description: 'Opaque ref://session/tool/uuid; a locator, never authority.' },
    createdAt: { ...integer, description: 'Unix milliseconds.' },
    ttlMs: { ...integer, description: '0 means session lifetime; otherwise at most 604800000 milliseconds.' },
    schemaVersion: string, producerTool: string, totalItems: integer, totalBytes: integer, preview: string,
  }, required: ['refId', 'createdAt', 'ttlMs', 'schemaVersion', 'producerTool', 'totalItems', 'totalBytes', 'preview'],
}
export const RESULT_PAGE_PARAMETERS = {
  root: { ...string, description: 'Absolute root bound to the original reference. Native defaults to current session cwd; PTC defaults to workspace root.' },
  id: { ...string, description: 'Use the returned reference.refId unchanged.' },
  offset: { ...integer, description: 'Nonnegative filtered-row offset; default 0.' },
  limit: { ...integer, description: '1-512 rows; default 64.' },
  maxBytes: { ...integer, description: '512-65536 serialized bytes; default 16384. Reduce this if Native display is incomplete.' },
  fields: { type: 'array', description: 'At most 32 top-level field names, each at most 128 bytes.', items: string },
  equals: { type: 'object', description: 'At most 16 top-level exact-value filters, applied before projection and paging.' },
} satisfies Record<string, JsonSchemaNode>
export const NATIVE_RESULT_PARAMETERS: ParameterSchema = {
  type: 'object', properties: { action: { type: 'string', enum: ['page', 'release'] }, ...RESULT_PAGE_PARAMETERS },
  required: ['action', 'id'], additionalProperties: false,
}
export const NATIVE_RESULT_DESCRIPTION = 'Page or release an owned ref:// snapshot. No put, audit IDs, or business writes. root defaults to current session cwd; pass the returned root after cwd changes. Page defaults offset=0, limit=64, maxBytes=16384. Follow nextOffset only when all page rows are displayed; page complete never proves the source operation complete. equals filters before fields projection; offsets count filtered stored rows, including chunks. Tagged item-json-chunk rows are JSON text fragments: join text in byteOffset order for one index, then parse only after complete=true. References expire with the session or ttlMs and require current authority and producer visibility. Release removes only cached observations. Failures are returned error values.'
