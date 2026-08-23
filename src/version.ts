/**
 * Muninn's own version.
 *
 * Kept as a literal rather than imported from package.json: pi loads this
 * extension as TypeScript source on both Node and Bun, and a JSON import
 * attribute is one more thing to differ between them. `test/unit/version.test.ts`
 * asserts this stays in step with package.json.
 */
export const MUNINN_VERSION = "0.1.0";
