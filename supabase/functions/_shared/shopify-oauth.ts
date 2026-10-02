const encoder = new TextEncoder()
const shopPattern = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function normalizeShopDomain(value: unknown) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//u, '').replace(/\/$/u, '')
  return shopPattern.test(normalized) ? normalized : null
}

export function randomOauthState() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashOauthState(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

async function encryptionKey(encodedKey: string, usages: KeyUsage[]) {
  const bytes = fromBase64Url(encodedKey.trim())
  if (bytes.byteLength !== 32) throw new Error('shopify_encryption_key_invalid')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, usages)
}

export async function encryptShopifyToken(token: string, encodedKey: string, shop: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await encryptionKey(encodedKey, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(shop),
  }, key, encoder.encode(token))
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) }
}

export async function decryptShopifyToken(
  ciphertext: string,
  iv: string,
  encodedKey: string,
  shop: string,
) {
  const key = await encryptionKey(encodedKey, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encoder.encode(shop),
  }, key, fromBase64Url(ciphertext))
  return new TextDecoder().decode(plaintext)
}

function equal(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}

export async function verifyShopifyHmac(params: URLSearchParams, clientSecret: string) {
  const supplied = params.get('hmac')
  if (!supplied || !/^[0-9a-f]{64}$/iu.test(supplied)) return false
  const entries = [...params.entries()].filter(([key]) => key !== 'hmac')
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return false
  entries.sort(([left], [right]) => left.localeCompare(right, 'en'))
  const message = entries.map(([key, value]) => `${key}=${value}`).join('&')
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(clientSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
  return equal(expected, Uint8Array.from(supplied.match(/.{2}/gu)!, (pair) => Number.parseInt(pair, 16)))
}
