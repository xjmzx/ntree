import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { VERDICTS, type Verdict } from "../lib/tauri";
import { cn } from "../lib/cn";
import { LeafIcon } from "./LeafIcon";

export type SampleFilter = "all" | "sampled" | "unsampled";

export interface FilterState {
  verdict: "All" | Verdict;
  search: string;
  /**
   * Filter by whether a track has a 10s clip on disk under the workspace
   * dest. Set to `"all"` to ignore. App-level `hasSample` decides per row.
   */
  sample: SampleFilter;
}

interface FiltersProps {
  filter: FilterState;
  setFilter: (f: FilterState) => void;
}

/**
 * Bare filter controls — no Section wrapper of its own; the parent
 * Library Section embeds these as a header band.
 */
export function Filters({ filter, setFilter }: FiltersProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  // Local search text so typing is instant; the expensive committed filter
  // (re-filters all rows + re-groups the tree) only fires ~200ms after the
  // last keystroke. Kept in sync when search is cleared/changed externally
  // (e.g. Esc).
  const [searchInput, setSearchInput] = useState(filter.search);
  useEffect(() => {
    setSearchInput(filter.search);
  }, [filter.search]);
  useEffect(() => {
    if (searchInput === filter.search) return;
    const id = setTimeout(
      () => setFilter({ ...filter, search: searchInput }),
      200,
    );
    return () => clearTimeout(id);
  }, [searchInput, filter, setFilter]);

  // Ctrl+F focuses the search box (matches the Tk app's binding).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {/* appearance-none + custom chevron because WebKit2GTK applies the
          system GTK theme to native <select> (often white-on-grey),
          ignoring our bg-bg / text-fg. */}
      <div className="relative">
        <select
          value={filter.verdict}
          onChange={(e) => setFilter({ ...filter, verdict: e.target.value as FilterState["verdict"] })}
          className="appearance-none pl-3 pr-8 py-2 rounded-md bg-bg text-fg outline-none
                     border border-transparent focus:border-accent/50 text-sm cursor-pointer"
        >
          <option value="All">All</option>
          {VERDICTS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <ChevronDown
          size={14}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
        />
      </div>

      {/* Clip-exists filter — one leaf toggle that cycles the three states:
          off (grey, all) → has clip (green) → no clip (purple) → off. A single
          button reads as a toggle; colour carries the state. Square-rounded bg,
          leaf sized near-max to the control height, leaning ~10° past 12:00. */}
      {(() => {
        const next: Record<SampleFilter, SampleFilter> = {
          all: "sampled",
          sampled: "unsampled",
          unsampled: "all",
        };
        const STATE: Record<SampleFilter, { cls: string; title: string }> = {
          all: {
            cls: "bg-surface text-muted hover:text-fg",
            title: "Clip filter off — all tracks. Click to show only tracks with a clip.",
          },
          sampled: {
            cls: "bg-accent text-bg",
            title: "Showing only tracks with a clip. Click to show only tracks without one.",
          },
          unsampled: {
            cls: "bg-mauve text-bg",
            title: "Showing only tracks without a clip. Click to clear.",
          },
        };
        const s = STATE[filter.sample];
        return (
          <button
            type="button"
            onClick={() => setFilter({ ...filter, sample: next[filter.sample] })}
            aria-pressed={filter.sample !== "all"}
            aria-label="Clip filter"
            title={s.title}
            className={cn(
              "flex items-center justify-center h-9 w-9 rounded-md transition-colors",
              s.cls,
            )}
          >
            <LeafIcon size={28} className="rotate-[10deg]" />
          </button>
        );
      })()}

      <div className="flex-1 min-w-[200px] relative">
        <Search
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
        />
        <input
          ref={searchRef}
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="search path…  (Ctrl+F · Esc clears)"
          className="w-full pl-8 pr-3 py-2 rounded-md bg-surface text-fg
                     placeholder:text-muted outline-none border border-transparent
                     focus:border-accent/50 text-sm"
          spellCheck={false}
        />
      </div>

    </div>
  );
}
