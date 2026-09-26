/** Display helper: first letter upper-case, rest untouched (voice-added items
 *  often arrive all lower-case). Leading whitespace is preserved. */
export function capitalizeFirst(text: string): string {
  return text.replace(/^(\s*)(\p{Ll})/u, (_, lead: string, ch: string) => lead + ch.toLocaleUpperCase());
}
