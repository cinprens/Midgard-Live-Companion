# MIDGARD live adventure artwork

Original cosmetic illustrations generated for this project with the built-in imagegen tool on 2026-11-05. They are not extracted game-client sprites and do not represent a player's actual class, equipment or location.

- `feminine-1.png` … `feminine-4.png`: four selectable feminine appearances.
- `masculine-1.png` … `masculine-3.png`: three selectable masculine appearances.
- `scene.png`: shared decorative town scene.
- `loot-card.png`, `loot-costume.png`, `loot-generic.png`: category artwork. All ordinary items, including Old Blue Box, use the same generic artwork.

The PNGs are preserved as generated. Character and loot PNGs contain transparency. Character preferences store only stable IDs, never filesystem paths.

Run `node scripts/verify-live-adventure-assets.mjs` from the project root to validate the PNG structure, alpha transparency and distinct image hashes.
