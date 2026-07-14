import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search, Radio } from "lucide-react";
import { VERDICTS, type Verdict } from "../lib/tauri";

export type SampleFilter = "all" | "sampled" | "unsampled";

export interface FilterState {
  verdict: "All" | Verdict;
  search: string;
  /**
   * Filter by whether a track has a 10s clip on disk under the workspace
   * dest. Set to `"all"` to ignore. App-level `hasSample` decides per row.
   */
  sample: SampleFilter;
  /**
   * Narrow to tracks inside RELEASES ndisc has published to Nostr (kind:31237).
   * Read from the suite-shared manifest ndisc exports — ntree has no idea what
   * is released on its own. `"all"` ignores it; unavailable when no manifest
   * has been exported.
   *
   * Called "released", NOT "published", on purpose. ntree already uses
   * "published" (and the same mauve) in the Library tree for something else
   * entirely: a *clip* this app pushed as a NIP-94 kind:1063 file event. Two
   * different kinds, two different subjects, two different sources of truth —
   * they must not share a word.
   */
  released: ReleasedFilter;
}

export type ReleasedFilter = "all" | "released";

interface FiltersProps {
  filter: FilterState;
  setFilter: (f: FilterState) => void;
  /** How many releases ndisc has published (from its manifest); null when no
   *  manifest has been exported, in which case the filter is not offered. */
  manifestCount: number | null;
}

/**
 * Bare filter controls — no Section wrapper of its own; the parent
 * Library Section embeds these as a header band.
 */
export function Filters({ filter, setFilter, manifestCount }: FiltersProps) {
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

      {/* Clip-exists filter — one dot toggle cycling the three states:
          off (grey, all) → has clip (green) → no clip (mauve) → off. A single
          button reads as a toggle; the dot's hue carries the state. */}
      {(() => {
        const next: Record<SampleFilter, SampleFilter> = {
          all: "sampled",
          sampled: "unsampled",
          unsampled: "all",
        };
        const STATE: Record<SampleFilter, { dot: string; title: string }> = {
          all: {
            dot: "bg-muted/50",
            title: "Clip filter off — all tracks. Click to show only tracks with a clip.",
          },
          sampled: {
            dot: "bg-ok/80",
            title: "Showing only tracks with a clip. Click to show only tracks without one.",
          },
          unsampled: {
            dot: "bg-mauve",
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
            className="flex items-center justify-center h-9 w-9 rounded-md
                       bg-surface hover:bg-surfaceHover transition-colors"
          >
            <span
              className={`w-2.5 h-2.5 rounded-full transition-colors ${s.dot}`}
            />
          </button>
        );
      })()}

      {/* ndisc-released filter. Only rendered when a manifest exists — with no
          manifest the filter cannot mean anything, and a dead control that
          silently matches nothing is worse than no control.

          The tooltip spells out kind:31237 and the word "release", because the
          Library tree's mauve dot means a *clip* published as kind:1063. Same
          colour, adjacent controls, entirely different fact. */}
      {manifestCount != null && (
        <button
          type="button"
          onClick={() =>
            setFilter({
              ...filter,
              released: filter.released === "all" ? "released" : "all",
            })
          }
          aria-pressed={filter.released === "released"}
          aria-label="ndisc-released filter"
          title={
            filter.released === "released"
              ? `Showing only tracks inside the ${manifestCount.toLocaleString()} RELEASES ndisc has published to Nostr (kind:31237). Click to clear.\n\nNot to be confused with the Library's mauve dot, which marks a CLIP this app published (kind:1063).`
              : `Show only tracks inside the ${manifestCount.toLocaleString()} releases ndisc has published to Nostr (kind:31237) — the scope for sampling the published discography.\n\nNot to be confused with the Library's mauve dot, which marks a clip this app published (kind:1063).`
          }
          className={`flex items-center gap-1.5 h-9 px-2.5 rounded-md text-xs
                      transition-colors ${
                        filter.released === "released"
                          ? "bg-mauve/20 text-mauve"
                          : "bg-surface hover:bg-surfaceHover text-muted"
                      }`}
        >
          <Radio size={13} />
          released
        </button>
      )}

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
