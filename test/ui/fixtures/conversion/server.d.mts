export type ConversionFixtureManifest = {
  kind: string;
  sourcePins: { path: string; sha256: string }[];
  assets: { url: string; sha256: string; byteLength: number }[];
  expectedScenarios: number;
  readsAccountsOrEnvironmentFiles: boolean;
};
export function prepareConversionFixture(): Promise<{ assets: Map<string, { bytes: Uint8Array; type: string }>; manifest: ConversionFixtureManifest }>;
export function startConversionFixture(options?: { port?: number }): Promise<{
  origin: string;
  manifest: ConversionFixtureManifest;
  close(): Promise<void>;
}>;
