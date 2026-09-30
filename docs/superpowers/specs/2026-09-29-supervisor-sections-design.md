# Supervisor dashboard in three parts — design

Date: 2026-09-29. Approved by the product owner in conversation.

## Problem

`supervisor.html` is one 15,500 px page: a jurisdiction picker, five counts,
two notes, a map, every waiting issue as a full card — each card carrying an
always-open clock-override form — and the resolution-durability panel under all
of it. The sidebar's queue buttons only filtered that one long list.

## Design

Three parts, one on screen at a time, switched from the sidebar and addressed
by hash (the resident dashboard's pattern):

| Part                  | Hash                         | Holds                                                                                                                              |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Overview (default)    | `#overview`                  | five queue tiles (each opens that queue), a one-line durability summary linking to Durability                                      |
| Waiting issues        | `#queues`, `#queues/<queue>` | the issue list and its map for the chosen queue, the two notes ("elapsed time, not urgency", "recorded internally, not delivered") |
| Resolution durability | `#durability`                | preamble, the units that can be told apart, every signal, the no-ranking note, the limits                                          |

- **Sidebar:** Overview · Waiting issues (total) with the six queues nested
  under it, each with its count · Resolution durability · then District
  dashboard and Compare policies. Queue items are plain links
  (`#queues/overdue`), so back/forward walk through them. The old
  `#durability-heading` link keeps working.
- **One scope bar** above all three parts: role line, jurisdiction picker,
  assessed-at time, Refresh (reloads queues and durability).
- **h1 names the part:** "At a glance" / "What is still waiting" /
  "Did the work last?". Headings descend h1 → h2 → h3 in every part.
- **Compact cards:** queues, reference, status, the two clocks and any alert
  with "Mark as seen" stay visible. The facts and "Why is this here?" fold into
  one disclosure; the clock override folds into "Change this issue's clock".
- The hidden `queue-filter` select is removed; the hash is the one source of
  the chosen queue.

## Not changing

Server, API client, every other element id the script uses, the durability
wording and its refusals, the notes' text.

## Verification

Unit tests for hash parsing (views, queues, fallbacks, the legacy anchor);
`npm run check`; browser walk-through of all three parts, every queue link,
back/forward, the folded override still saving, desktop and phone.
