// Pure function powering the homepage chip-click handler. Extracted so the
// three input-state branches (empty / SHA-shape / garbage) are unit-testable;
// the inline JS in layout.tsx just calls this and writes the result back.

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Given the input field's current value and the alias of the clicked chip,
 * compute the new input value:
 *   empty/whitespace  → `"<alias> "`
 *   SHA-shape         → `"<alias> <sha>"` (preserves the SHA the user pasted)
 *   anything else     → `"<alias> "`      (replaces garbage)
 */
export function computeChipClickInputValue(currentValue: string, alias: string): string {
  const trimmed = currentValue.trim();
  if (SHA_RE.test(trimmed)) {
    return `${alias} ${trimmed}`;
  }
  return `${alias} `;
}
