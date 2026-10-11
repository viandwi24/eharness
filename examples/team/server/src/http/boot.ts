/** Identifies this server process: a client that sees it change knows the server restarted. */
export const BOOT_ID: string = crypto.randomUUID()
