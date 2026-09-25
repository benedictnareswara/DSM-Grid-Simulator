import type { ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * The one inline banner.
 *
 * This markup — wrapper, `__body`, a `<strong>` headline, optional dismiss —
 * was hand-copied into four files (login, register, AccountsPanel and the
 * account detail page), and the copies had already drifted: two of them wrapped
 * their headline in `<strong>`, one didn't, and only one had a dismiss button.
 *
 * `tone` is the semantic, not the colour. "pending" exists because a household
 * whose account is awaiting approval has not done anything wrong — the password
 * was correct — so it must not read like a failure. That distinction was
 * previously re-derived at each call site.
 */
export type NoticeTone = "info" | "pending" | "error";

const TONE_CLASS: Record<NoticeTone, string> = {
  info: "",
  pending: "ds-notice--warn",
  error: "ds-notice--error",
};

/**
 * A banner for an error, warning or piece of guidance.
 *
 * Exists because the same markup had been hand-copied four times; reach for
 * it rather than writing another banner.
 */
export function Notice({
  tone = "info",
  title,
  children,
  onDismiss,
  className = "",
}: {
  tone?: NoticeTone;
  /** Rendered bold above the body. Omit for a single-line notice. */
  title?: ReactNode;
  children?: ReactNode;
  /** Renders a dismiss button when provided. */
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div className={`ds-notice ${TONE_CLASS[tone]} ${className}`.trim()}>
      <div className="ds-notice__body">
        {title && <strong>{title}</strong>}
        {title && children ? <p className="ds-notice__text">{children}</p> : children}
      </div>
      {onDismiss && (
        <button
          type="button"
          className="ds-notice__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
