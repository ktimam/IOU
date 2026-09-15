// Preserve the existing public normalization API while sharing the exact policy with the app
// prompt. The dependency-free policy module never imports the manifest, avoiding a cycle.
export { normalizeImageCurrencyToken } from "./currencyEvidencePolicy";
export type { ImageCurrencyMapping } from "./currencyEvidencePolicy";
