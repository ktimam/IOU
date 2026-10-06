/** User-facing names only. Identifiers remain in the encrypted recipient binding. */
export function localConnectionLabels(index: number, accountName?: string, sheetName?: string) {
  return {
    accountName: accountName?.trim() || `Account ${index + 1}`,
    sheetName: sheetName?.trim() || "Current sheet",
  };
}

export function localConnectionLabel(names: { accountName: string; sheetName: string }): string {
  return `${names.accountName} — ${names.sheetName}`;
}
