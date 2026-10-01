import type { I18nService } from 'nestjs-i18n';

export const FALLBACK_LOCALE = 'en';

/**
 * Translates an event code (`events.<CODE>`) for the response body. Shared by
 * the exception filter and the response interceptor so success and failure
 * messages resolve the same way.
 *
 * nestjs-i18n already retries the fallback locale when the requested one
 * lacks the key; when no locale has it, it returns the key itself. A raw
 * `events.X` on screen reads like a crash, so that case degrades to a generic
 * message instead.
 */
export function translateEvent(
  i18n: I18nService,
  code: string,
  lang: string | undefined,
  args: Record<string, unknown> = {},
): string {
  const key = `events.${code}`;
  // Typed `unknown` because the key is built at runtime; a nested key would
  // also come back as an object, which is not a message either.
  const message: unknown = i18n.translate(key, {
    lang: lang ?? FALLBACK_LOCALE,
    args,
  });
  if (typeof message === 'string' && message !== key) return message;
  return String(
    i18n.translate('events.UNKNOWN_EVENT', { lang: lang ?? FALLBACK_LOCALE }),
  );
}
