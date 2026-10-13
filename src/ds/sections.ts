/**
 * Splitting the markdown document into lockable sections.
 *
 * A "section" is a heading and everything beneath it until the next heading of the same
 * or higher level. That gives the mutual-exclusion algorithms a concrete, user-meaningful
 * resource to arbitrate -- "only one person may restructure Methods at a time" -- rather
 * than an abstract critical section invented for the demo.
 *
 * Section ids are derived from the heading text rather than from character offsets, so a
 * lock survives edits elsewhere in the document. Two headings with the same text get
 * distinguished by an index suffix, because a lock id must identify exactly one resource.
 */

import type { SectionId } from "./types";

export type DocumentSection = {
  id: SectionId;
  title: string;
  level: number;
  /** Character offset where the section's content begins (start of the heading line). */
  from: number;
  /** Character offset just past the end of the section. */
  to: number;
};

/** Everything before the first heading, so the preamble is lockable too. */
export const PREAMBLE_ID = "preamble";

export function parseSections(text: string): DocumentSection[] {
  const lines = text.split("\n");
  const sections: DocumentSection[] = [];
  const seen = new Map<string, number>();

  let offset = 0;
  const starts: { index: number; title: string; level: number; from: number }[] = [];

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      starts.push({
        index: starts.length,
        title: match[2].trim() || "untitled",
        level: match[1].length,
        from: offset,
      });
    }
    offset += line.length + 1;
  }

  const total = text.length;

  // Anything before the first heading is its own section.
  if (starts.length === 0 || starts[0].from > 0) {
    const end = starts.length === 0 ? total : starts[0].from;
    if (end > 0) {
      sections.push({
        id: PREAMBLE_ID,
        title: "(preamble)",
        level: 0,
        from: 0,
        to: end,
      });
    }
  }

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];

    // The section runs until the next heading at the same or a higher level.
    let end = total;
    for (let j = i + 1; j < starts.length; j += 1) {
      if (starts[j].level <= start.level) {
        end = starts[j].from;
        break;
      }
    }

    const base = slugify(start.title);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;

    sections.push({
      id,
      title: start.title,
      level: start.level,
      from: start.from,
      to: end,
    });
  }

  return sections;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/**
 * Character ranges a given node may not edit, because another node holds the section.
 *
 * This is the point where the abstract lock becomes a concrete restriction the user can
 * feel: the editor rejects any transaction that touches one of these ranges.
 */
export function lockedRanges(
  text: string,
  holders: Map<SectionId, number>,
  selfId: number,
): { from: number; to: number; holder: number; title: string }[] {
  const ranges: { from: number; to: number; holder: number; title: string }[] = [];

  for (const section of parseSections(text)) {
    const holder = holders.get(section.id);
    if (holder !== undefined && holder !== selfId) {
      ranges.push({ from: section.from, to: section.to, holder, title: section.title });
    }
  }

  return ranges;
}
