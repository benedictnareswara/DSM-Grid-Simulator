import Link from "next/link";
import { Icon } from "@/components/Icon";

/**
 * The title block at the top of an admin page.
 *
 * What is left of `AdminNav` after the shell took the rest. The nav chips, the
 * username, the logout button, the route guard and the three live badges all
 * moved into `app/admin/AdminSidebar.tsx`, where they persist across
 * navigation instead of being rebuilt per page. This is only the words.
 *
 * `back` exists for the one route that is two levels deep,
 * `/admin/accounts/[id]`. It previously marked itself as the Accounts page in
 * the nav and offered no way up except the browser button — the sole exception
 * being a link buried inside the not-found empty state.
 */
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
