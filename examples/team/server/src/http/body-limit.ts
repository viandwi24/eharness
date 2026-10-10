import { bodyLimit } from 'hono/body-limit'

/** Chat requests carry attachments as data URLs (base64): a little above the 10 MB file limit. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024

export const requestLimit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `request body is larger than ${maxSize} bytes`,
          },
        },
        413,
      ),
  })
