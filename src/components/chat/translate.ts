/**
 * i18n helper for the chat presentational components.
 *
 * The locale dictionary ships English and Arabic today and new keys land
 * through the strings owner, so a key that has no translation in the active
 * locale resolves to the plain English wording instead of a raw key name.
 */
export type Translate = (key: string) => string;

export const withFallback =
  (t: Translate) =>
  (key: string, fallback: string): string => {
    const value = t(key);
    return !value || value === key ? fallback : value;
  };
