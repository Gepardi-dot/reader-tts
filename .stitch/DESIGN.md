# Design System: Storybook Reader
**Project ID:** 8046194451342997602
**Status:** Active design direction switched on 2026-04-05 to the generated `library-overview-honey-oak` variant. Stitch's strongest generated alias for this direction is `Honey Oak Library`.

## 1. Creative North Star

Storybook Reader should now feel like a straight-on view into a bespoke personal archive. The product is less "app interface around books" and more "architectural bookshelf that happens to be interactive." The mood should be warm, calm, literary, and collected, like stepping up to a beautifully maintained honey-oak wall of books and notes.

Three traits matter most:

- **Architectural shelving:** Shelf planks, recessed bays, and row structure should carry the layout instead of floating app containers.
- **Paper-and-brass details:** Notes, metadata, and controls should read like parchment slips, catalog cards, and engraved brass plaques.
- **Editorial calm:** The experience should remain premium and adult, with careful typography and warm ambient light rather than playful decoration.

This direction follows an "architectural shelf wall" logic:

- Big containers should feel like shelving, bays, or reading ledges.
- Small information surfaces should feel pinned, slotted, or tucked into the architecture.
- Primary actions should feel engraved or plated, not bubbly or app-soft.

## 2. Color System

- **Honey Oak Base (`#FFF8F5`, `#FFEADC`, `#FFF1E9`)** is the new dominant neutral world. Use it for page grounds, shelf fields, and the soft architectural body of the interface.
- **Warm Timber Shadow (`#A98467`, `#82756A`, `#442B14`)** carries wood depth, shelf edges, shadowed recesses, and darker accent typography.
- **Parchment Insert (`#FFDCC2`)** is the paper-facing surface for notes, ledger cards, metadata panels, and tactile slips.
- **Brass Signal (`#F6BD62` family, with darker plaque tones around `#805600` and `#D9A34B`)** remains the primary accent and should read like polished engraved hardware.
- **Oxide Rose (`#C1666B` to `#97454A`)** remains the note and annotation accent.
- **Alpine Teal (`#4A7C7A` to `#346665`)** remains the system-status and technical-readiness accent.

### Tonal Rules

- Prefer warm tonal shifts over heavy borders.
- Use wood depth, paper contrast, and shelf rhythm to define sections.
- Keep dark tones selective. The interface should feel lighter and more architectural than the earlier midnight-lacquer direction.

## 3. Typography

- **Newsreader** is now both the display and body-led literary voice. Use it for titles, descriptive copy, and refined content blocks.
- **Work Sans** is the label and metadata face. Use it for utility text, catalog tags, controls, and all-caps plaque labels.
- Use italics deliberately for shelf notes, secondary descriptions, and handwritten-feeling supporting copy.

Type should feel editorial and archival, not product-marketing loud.

## 4. Layout And Composition

- Desktop-first remains the default.
- Prefer a straight-on, architectural view of multiple shelf rows.
- Show more shelf rhythm and less empty negative space.
- Keep one featured reading bay, but let the wider archive wall dominate the composition.
- Avoid isolated dashboard modules. Most information should be integrated into the shelf environment itself.

### Viewport Rules

- For every app screen except the dedicated reader page, design for a single desktop viewport with no vertical scrolling.
- Assume a premium laptop canvas around 1440x900 to 1600x1000 and make the full primary workflow visible immediately.
- All core options, states, and actions should be visible on first load.
- If a layout starts growing tall, compress by increasing hierarchy and reducing secondary detail rather than pushing content below the fold.
- Scrolling is allowed only for the dedicated reading page, where long-form content is the product.

## 5. Component Rules

- **Bookshelves:** Use visible plank thickness, tighter shelf spacing, and multiple rows. Books should sit on shelves like physical objects, not hover inside cards.
- **Books:** Favor front-facing covers with varied size, tone, and material character. Slight variation is good if the whole wall still feels composed.
- **Buttons:** Primary actions should look like brass plaques or engraved rectangular controls with slight rounding only.
- **Notes and metadata:** Prefer parchment slips, ledger cards, clipped labels, and shelf tabs.
- **Panels:** Use ledgers, note cards, inset trays, and shelf-mounted labels instead of generic app panels.
- **Technical controls:** The provider/playback layer should feel like a side nook, cabinet, or catalog station integrated into the architecture.

### Shape Rules

- Avoid pills.
- Prefer square or lightly softened corners.
- If something feels too "app-ish," reduce its radius and integrate it into the shelf structure.

## 6. Stitch Prompt Block

Copy this block directly into Stitch prompts for new screens:

```md
**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, desktop-first with responsive mobile fallback
- Mood: Architectural personal archive, honey-oak bookshelf wall, tactile, warm, literary, calm
- Background: Honey Oak Base (#FFF8F5, #FFEADC, #FFF1E9) with Warm Timber Shadow accents (#A98467, #82756A, #442B14) for depth and shelving structure
- Surface Light: Parchment Insert (#FFDCC2) for slips, ledger cards, notes, and paper-facing content
- Primary Accent: Brass Signal family with plaque tones around #805600, #D9A34B, and #F6BD62 for engraved actions and highlighted reading controls
- Secondary Accent: Oxide Rose (#C1666B to #97454A) for notes, highlights, and annotation warmth
- Supporting Accent: Alpine Teal (#4A7C7A to #346665) for playback readiness, provider metadata, and technical confidence
- Text Primary: Warm timber-dark text (#2C1603 / #442B14) on light surfaces; reserve dark backgrounds for small anchored areas only
- Text Secondary: Warm catalog tones, never cold gray
- Typography: Newsreader for headlines and literary body, Work Sans for labels and metadata
- Bookshelves: Straight-on shelf wall, visible plank thickness, multiple rows, front-facing covers, and tighter rhythmic spacing
- Buttons: Brass plaques or engraved rectangular controls with only slight rounding, no pill-heavy UI
- Panels: Parchment slips, ledger cards, shelf tabs, and inset trays instead of generic app modules
- Inputs: Understated and embedded, as if part of a catalog station or reading ledge
- Layout: One featured reading bay inside a larger architectural shelf wall with dense but curated shelf rhythm
- Composition Rule: Replace empty dark luxury space with warm structured shelving and integrated paper details
- Shape Rule: Prefer square or lightly softened corners; surfaces should feel architectural, framed, or paper-cut
- Viewport Rule: Except for the dedicated reader page, all primary options and actions must fit within the first desktop screen with no vertical scrolling
```
