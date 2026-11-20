/** Shared pager for the four listing pages. */
export function Pager({
  offset,
  limit,
  count,
  onChange,
}: {
  offset: number;
  limit: number;
  count: number;
  onChange: (next: number) => void;
}) {
  const from = count === 0 ? 0 : offset + 1;
  const to = offset + count;
  return (
    <div className="ds-pager">
      <button
        className="ds-btn ds-btn--sm"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        ← Newer
      </button>
      <span className="ds-muted">
        {count === 0 ? "Nothing here" : `Showing ${from}–${to}`}
      </span>
      <button
        className="ds-btn ds-btn--sm"
        // The count endpoints are separate, so rather than fetch a total just to grey this out, "a
        // full page came back" is the signal there may be more.
        disabled={count < limit}
        onClick={() => onChange(offset + limit)}
      >
        Older →
      </button>
    </div>
  );
}
