# Stitch Site Plan: Storybook Reader

**Product:** Storybook Reader
**Stitch Project ID:** 8046194451342997602
**Purpose of this file:** Keep the multi-screen design loop aligned with the actual product instead of drifting into generic dashboard designs.

## 1. Product Summary

Storybook Reader turns PDFs into listenable audiobooks while preserving the emotional feeling of sitting at a reading desk. The product blends book browsing, two-page reading, note capture, vocabulary collection, and text-to-speech provider controls inside one premium reading workspace.

## 2. Core Audiences

- Readers who want personal PDF books converted into audio without losing the feeling of reading.
- Language learners who want to save notes and vocabulary while reading.
- Tinkerers comparing local and cloud TTS providers and adjusting voice settings precisely.

## 3. Experience Goals

- Make the book and reading desk feel like the hero, not the settings form.
- Make technical provider controls feel powerful but calm.
- Make the library feel curated and archival instead of like a file picker.
- Keep the product premium, tactile, and editor-designed rather than generic AI SaaS.

## 4. Sitemap

Mark a page complete only after a Stitch screen has been generated and saved locally.

- [x] `reader-desk` - Signature reading and listening workspace with the book spread, controls, and live playback context.
- [x] `library-overview` - Curated book gallery with current reading progress, saved notes, and archive entry points.
- [ ] `provider-lab` - Focused comparison page for TTS providers, voices, latency tradeoffs, and test playback.
- [ ] `vocabulary-studio` - Vocabulary archive and learning workflow tied to saved reading highlights.
- [ ] `marketing-home` - Public-facing landing page that sells the product mood and explains the workflow.
- [ ] `mobile-queue` - Compact mobile-first listening queue and current session view.

## 5. Roadmap

Work from top to bottom unless the user explicitly redirects.

1. `reader-desk` - Completed on 2026-04-05. This established the editorial dark system and reading-desk composition.
2. `library-overview` - Completed on 2026-04-05. This established the archive and discovery layer without flattening the editorial hierarchy.
3. `provider-lab` - Current baton. Give provider selection a clear, beautiful comparison layout.
4. `vocabulary-studio` - Expand the learning surface with notes, definitions, and review cues.
5. `marketing-home` - Distill the product into a bold public narrative once the internal visual language is stable.
6. `mobile-queue` - Adapt the system for smaller screens after the desktop hierarchy is proven.

## 6. Creative Freedom

Use these if the roadmap is empty or the user asks for exploratory screens.

- `book-detail` - A focused detail page for one title with chapter map, provider presets, and notes summary.
- `session-recap` - A post-listening recap page with progress, saved highlights, and next chapter suggestions.
- `notes-archive` - A high-density notes and highlights page with filters, excerpts, and book references.
- `voice-character-picker` - A voice selection experience that feels more like casting than a dropdown list.
- `onboarding-ritual` - A first-run flow that introduces upload, preview, provider choice, and test playback.
