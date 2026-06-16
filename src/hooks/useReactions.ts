// Reaction aggregator + publish/delete wrapper for ndisc.tree's FeedPanel.
//
// Reads kind:7 events via SimplePool (no signing required for reads).
// Writes go through Rust commands — `publish_reaction` / `delete_reaction`
// — so the secret key never leaves the keychain → renderer boundary.
//
// Ported from ndisc.view's useReactions hook with two adaptations:
//   - ndisc.tree reacts to non-replaceable events (kind:1063), so the
//     filter / dedup key is the event id (`#e`) instead of an `a` tag
//     replaceable address (`kind:pubkey:d`).
//   - signing is Rust-side (nostr-sdk), not in-browser NIP-46.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SimplePool, type Event as NostrEvent } from "nostr-tools";
import { classifyReaction, REACTION_UP } from "../lib/rating";
import { deleteReaction, publishReaction } from "../lib/tauri";

export type ReactionAgg = { up: number; down: number; mine: string | null };
const EMPTY: ReactionAgg = { up: 0, down: 0, mine: null };

const REACTION_RELAYS = ["wss://relay.fizx.uk", "wss://nos.lol"];

export interface FeedEventRef {
  id: string;
  pubkey: string;
}

export interface ReactionsAPI {
  forEvent: (eventId: string) => ReactionAgg;
  react: (eventId: string, content?: string) => Promise<void>;
  unreact: (eventId: string) => Promise<void>;
  canReact: boolean;
  busy: string | null; // event id currently being published / deleted
}

export function useReactions(
  events: FeedEventRef[],
  myPubkey: string | null,
  targetKind: number,
): ReactionsAPI {
  // event_id → reactor_pk → latest kind:7 event
  const latestRef = useRef<Map<string, Map<string, NostrEvent>>>(new Map());
  const [aggs, setAggs] = useState<Map<string, ReactionAgg>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const poolRef = useRef<SimplePool | null>(null);

  const myPubkeyRef = useRef<string | null>(myPubkey);
  myPubkeyRef.current = myPubkey;

  // Stable key for the dependency array — re-subscribe when the set of
  // event IDs actually changes, not on every render.
  const eventIdsKey = useMemo(
    () =>
      events
        .map((e) => e.id)
        .sort()
        .join(","),
    [events],
  );

  // event_id → author pubkey, for tagging publish calls
  const authorByEvent = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) m.set(e.id, e.pubkey);
    return m;
  }, [events]);

  const aggOf = useCallback((eid: string): ReactionAgg => {
    const inner = latestRef.current.get(eid);
    if (!inner) return EMPTY;
    let up = 0;
    let down = 0;
    let mine: string | null = null;
    for (const ev of inner.values()) {
      const k = classifyReaction(ev.content);
      if (k === "up") up++;
      else if (k === "down") down++;
      if (myPubkeyRef.current && ev.pubkey === myPubkeyRef.current) {
        mine = ev.id;
      }
    }
    return { up, down, mine };
  }, []);

  const refresh = useCallback(
    (eid: string) => {
      setAggs((m) => new Map(m).set(eid, aggOf(eid)));
    },
    [aggOf],
  );

  // Subscribe to reactions for the current set of feed event ids.
  useEffect(() => {
    if (events.length === 0) {
      latestRef.current = new Map();
      setAggs(new Map());
      return;
    }
    if (!poolRef.current) poolRef.current = new SimplePool();
    const pool = poolRef.current;
    const ids = events.map((e) => e.id);

    const sub = pool.subscribeMany(
      REACTION_RELAYS,
      { kinds: [7], "#e": ids },
      {
        onevent(ev) {
          const eTag = ev.tags.find((t) => t[0] === "e");
          if (!eTag) return;
          const eid = eTag[1];
          let inner = latestRef.current.get(eid);
          if (!inner) {
            inner = new Map();
            latestRef.current.set(eid, inner);
          }
          const prev = inner.get(ev.pubkey);
          if (
            prev &&
            !(
              ev.created_at > prev.created_at ||
              (ev.created_at === prev.created_at && ev.id < prev.id)
            )
          ) {
            return;
          }
          inner.set(ev.pubkey, ev);
          refresh(eid);
        },
      },
    );

    return () => {
      sub.close();
    };
  }, [eventIdsKey, refresh]);

  // Recompute `mine` across all events when identity changes.
  useEffect(() => {
    setAggs(() => {
      const next = new Map<string, ReactionAgg>();
      for (const eid of latestRef.current.keys()) next.set(eid, aggOf(eid));
      return next;
    });
  }, [myPubkey, aggOf]);

  // Close pool on unmount.
  useEffect(() => {
    return () => {
      poolRef.current?.close(REACTION_RELAYS);
      poolRef.current = null;
    };
  }, []);

  const react = useCallback(
    async (eventId: string, content: string = REACTION_UP) => {
      if (!myPubkeyRef.current) throw new Error("not signed in");
      const author = authorByEvent.get(eventId);
      if (!author) throw new Error("unknown author for event");
      setBusy(eventId);
      try {
        const result = await publishReaction(eventId, author, targetKind, content);
        // Optimistic local update — synthesize a minimal NostrEvent shape.
        let inner = latestRef.current.get(eventId);
        if (!inner) {
          inner = new Map();
          latestRef.current.set(eventId, inner);
        }
        inner.set(myPubkeyRef.current, {
          id: result.eventId,
          kind: 7,
          pubkey: myPubkeyRef.current,
          created_at: Math.floor(Date.now() / 1000),
          content,
          tags: [],
          sig: "",
        } as NostrEvent);
        refresh(eventId);
      } finally {
        setBusy(null);
      }
    },
    [authorByEvent, targetKind, refresh],
  );

  const unreact = useCallback(
    async (eventId: string) => {
      const me = myPubkeyRef.current;
      if (!me) throw new Error("not signed in");
      const inner = latestRef.current.get(eventId);
      const mine = inner?.get(me);
      if (!inner || !mine) return;
      setBusy(eventId);
      try {
        await deleteReaction(mine.id);
        inner.delete(me);
        refresh(eventId);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return {
    forEvent: (eventId: string) => aggs.get(eventId) ?? EMPTY,
    react,
    unreact,
    canReact: myPubkey != null,
    busy,
  };
}
