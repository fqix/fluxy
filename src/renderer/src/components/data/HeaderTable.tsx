export function HeaderTable({ values }: { values: Record<string, string> | [string, string][] }) {
    const entries = Array.isArray(values) ? values : Object.entries(values)
    return entries.length ? (
        <table className="kv">
            <thead>
                <tr>
                    <th>Key</th>
                    <th>Value</th>
                </tr>
            </thead>
            <tbody>
                {entries.map(([key, value], i) => (
                    <tr key={`${key}-${i}`}>
                        <td>{key}</td>
                        <td>{value}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    ) : (
        <div className="subtle-empty">No values</div>
    )
}
