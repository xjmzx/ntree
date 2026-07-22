import { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

interface SectionProps {
  /** Optional — omit (or pass empty) for icon-only headers. */
  title?: ReactNode;
  icon?: ReactNode;
  /** Optional right-side header content (chips, mini-controls). */
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  /**
   * Click handler for the header bar — when provided, the header reads
   * as interactive (cursor + dim-on-hover) and triggers this callback.
   * Used by collapsible panels: caller flips an `expanded` flag and
   * passes `false` as children to omit the body entirely.
   */
  onTitleClick?: () => void;
  /**
   * Render without the card chrome + header — just the children in a plain
   * column. Used to compose a panel inside another Section (e.g. Scanner +
   * Destination nested in one "Source & destination" card).
   */
  flat?: boolean;
}

export function Section({
  title,
  icon,
  right,
  children,
  className,
  contentClassName,
  onTitleClick,
  flat,
}: SectionProps) {
  if (flat) {
    return (
      <div className={cn("flex flex-col gap-3", contentClassName)}>
        {children}
      </div>
    );
  }
  const hasBody = children != null && children !== false;
  return (
    <section
      className={cn(
        "rounded-xl bg-panel shadow-md",
        hasBody ? "p-4 flex flex-col gap-3" : "px-4 py-2 flex flex-col",
        className,
      )}
    >
      <header
        onClick={onTitleClick}
        title={onTitleClick ? "Click the header to expand or collapse" : undefined}
        className={cn(
          "flex items-center gap-2 text-accent font-semibold shrink-0",
          onTitleClick &&
            "-mx-2 px-2 py-1 rounded-md cursor-pointer select-none " +
              "bg-fg/5 shadow-inner transition-colors hover:bg-fg/10",
        )}
      >
        {onTitleClick && (
          <span className="text-muted shrink-0" aria-hidden="true">
            {hasBody ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        )}
        {icon}
        {title && (
          <h2 className="text-sm tracking-wide uppercase">{title}</h2>
        )}
        {right && <div className="ml-auto text-fg/80">{right}</div>}
      </header>
      {hasBody && (
        <div className={cn("text-sm text-fg/90", contentClassName)}>{children}</div>
      )}
    </section>
  );
}
