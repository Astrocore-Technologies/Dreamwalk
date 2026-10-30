# Art-led homepage discovery

The homepage presents a large illustrated public adventure with manual neighboring
recommendations, a short hook, approved NPC cast, honest playability metadata and a
primary action. Artwork precedes copy on mobile. The existing plum/pearl/gold identity,
light/dark themes and Ukrainian, English and Russian strings remain supported.

Recommendations are labelled collections from the public library, not personalized
predictions. No autoplay, fabricated engagement counts or independent character carousel
was added. Genre-derived rails use actual catalog entries. The Continue area uses only
the signed-in player's accepted active campaigns; guests receive a sign-in link.

Featured cast requests explicitly use `GET /api/v1/adventures/:slug?view=published`.
This mode checks public visibility, an existing approved snapshot and non-archived state,
even when the visitor is the author. It returns read-only approved NPC metadata and no
draft version history. The existing unqualified detail route still supports owner drafts
and invited readers. Real uploaded portraits are used when available; the bundled seed
NPCs have none, so their named icon placeholders do not pretend to be generated artwork.

Start creates a campaign only for an available approved playable version. Otherwise the
page honestly offers story details. The ref-backed launch gate prevents duplicate starts
and ignores stale navigation responses after selection changes or unmount. Carousel
buttons, indicators and swipe are locked during a pending launch. There is no paid call.

Verification includes an isolated PostgreSQL test of actual submission/moderation followed
by author draft edits: approved title/cast/portrait remain unchanged and public, while
private/pending/archived published-view requests and unapproved portrait delivery fail.
Three launch-gate regressions cover same-tick repetition and stale responses.

Browser acceptance checks manual navigation, locale/theme responsiveness, loading/error
and empty states, approved-only metadata and guest/continuation behavior. Successful CI
captures `home-desktop-dark.png`, `home-desktop-light.png` and `home-mobile.png` from the
real browser after images/fonts settle. Source tests are not visual evidence: inspect the
actual captures before delivering them. No hosted deployment or user's local-app restart
is part of this change.
