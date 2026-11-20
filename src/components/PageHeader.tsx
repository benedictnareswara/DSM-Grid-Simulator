import Link from "next/link";
import { Icon } from "@/components/Icon";

/** The title block at the top of an admin page. */
export function PageHeader({
  title,
  subtitle,
  back,
  aside,
}: {
  title: string;
  subtitle?: string;
  /** Renders a breadcrumb above the title. */
  back?: { href: string; label: string };
  /** Page-level controls that belong beside the title rather than in the body. */
  aside?: React.ReactNode;
}) {
  return (
    <header className="ds-header">
      <div className="ds-header__titles">
        {back ? (
          <Link href={back.href} className="ds-crumb">
            <Icon name="chevronRight" size={14} className="ds-crumb__caret" />
            {back.label}
          </Link>
        ) : (
          <p className="ds-eyebrow">Grid Operator</p>
        )}
        <h1 className="ds-header__title">{title}</h1>
        {subtitle && <p className="ds-header__sub">{subtitle}</p>}
      </div>
      {aside && <div className="ds-header__aside">{aside}</div>}
    </header>
  );
}
