type PreviewType = Readonly<{ id: string; name: string; direction: "credit" | "debt"; keywords?: readonly string[] }>;

/** The existing sheet setup preview, shared by legacy and chat-scoped connection. */
export function LocalSetupTypesPreview({ defaultCurrency, loading, ready, error, types }: {
  defaultCurrency: string; loading: boolean; ready: boolean; error: boolean; types: readonly PreviewType[];
}) {
  return <>
    <p>Currency: {defaultCurrency || "Not set"}</p>
    {(loading || (!ready && !error)) && <p>Loading this sheet’s private Types…</p>}
    {error && <p role="alert">This sheet’s private Types could not be read. Sharing is disabled.</p>}
    {ready && <ul>{types.map(type => <li key={type.id}>{type.name}: {type.direction === "credit" ? "Owed to you" : "You owe"}; keywords: {(type.keywords ?? []).join(", ") || "name only"}</li>)}</ul>}
  </>;
}
