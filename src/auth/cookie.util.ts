/**
 * One cookie's value from a raw Cookie header, or undefined. The API reads a
 * single cookie (the refresh token) on three routes, which does not earn a
 * cookie-parsing middleware on every request.
 */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      // A malformed escape is a tampered cookie; treat it as absent.
      return undefined;
    }
  }
  return undefined;
}
