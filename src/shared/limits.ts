export const BODY_LIMIT = 16 * 1024
export const RAW_LIMIT = 32 * 1024
export const VARIABLES_LIMIT = 32 * 1024
export const JSON_REQUEST_LIMIT = 256 * 1024

const encoder = new TextEncoder()
export const utf8ByteLength = (text: string): number => encoder.encode(text).byteLength
