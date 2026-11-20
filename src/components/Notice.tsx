import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** The one inline banner. */
export type NoticeTone = "info" | "pending" | "error";

const TONE_CLASS: Record<NoticeTone, string> = {
  info: "",
  pending: "ds-notice--warn",
  error: "ds-notice--error",
};

/** A banner for an error, warning or piece of guidance. */
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
