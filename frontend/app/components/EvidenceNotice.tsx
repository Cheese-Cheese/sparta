export interface RepositoryCoverage {
  status: "complete" | "partial" | "unknown" | "unavailable";
  included_count?: number;
  total_files?: number;
  omitted?: Record<string, number>;
  truncated_files?: string[];
}

export interface EvidenceCheck {
  claim: string;
  source_file: string;
  excerpt: string;
}

export default function EvidenceNotice({ coverage, checks = [], hasGithub }: {
  coverage?: RepositoryCoverage;
  checks?: EvidenceCheck[];
  hasGithub?: boolean;
}) {
  return (
    <section aria-label="Evidence coverage" className="mb-6 border border-line bg-surface p-4 text-sm text-muted">
      <p className="font-semibold text-ink">Evidence coverage</p>
      <p className="mt-1">
        {!hasGithub ? "Resume claims only. Repository evidence is unavailable."
          : coverage?.included_count !== undefined && coverage.total_files !== undefined
            ? `${coverage.included_count} of ${coverage.total_files} repository files included. ${coverage.status === "complete" ? "All file text was included within the sample limits." : "This is a partial sample."}`
            : "Repository coverage is unknown. Analyze the resume again to get coverage details."}
      </p>
      {coverage?.omitted && Object.values(coverage.omitted).some(count => count > 0) && (
        <p className="mt-1">Files omitted: {Object.entries(coverage.omitted)
          .filter(([, count]) => count > 0)
          .map(([reason, count]) => `${reason.replaceAll("_", " ")}: ${count}`).join("; ")}.</p>
      )}
      {!!coverage?.truncated_files?.length && (
        <p className="mt-1 break-words">Files cut short: {coverage.truncated_files.join(", ")}.</p>
      )}
      <p className="mt-2">AI suggestions need your review. Missing code does not prove a false claim. Source quotes do not verify authorship or production results.</p>
      {checks.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer font-medium text-ink">Source quotes checked against sampled text ({checks.length})</summary>
          <ul className="mt-3 space-y-3">
            {checks.map((check, index) => (
              <li key={`${check.source_file}-${index}`}>
                <p className="text-ink">{check.claim}</p>
                <p className="mt-1 break-all font-mono text-xs">{check.source_file}</p>
                <pre className="mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-xs">{check.excerpt}</pre>
              </li>
            ))}
          </ul>
        </details>
      ) : <p className="mt-2">No checked source quotes accompany this review.</p>}
    </section>
  );
}
