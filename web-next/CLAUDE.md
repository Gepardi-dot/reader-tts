# web-next — Claude Agent Notes

Next-generation frontend for Storybook Reader. Replaces `web-rewrite/` when complete.

## Stack
- React 19 + Vite 8 + React Router v7
- Tailwind CSS v4 + shadcn/ui (base-ui primitives)
- TanStack Query v5 + Zustand
- TypeScript 6 (strict)

## Design language
- **App shell**: Notion.so — sidebar nav (240px), surface `#f7f7f5`, text `#37352f`
- **Reader page**: Kindle — warm paper `#fbf8f4`, Lora serif, 17px/1.85, continuous scroll

## Dev server
```
npm run dev   # port 5175
npm run build # production build
npm run typecheck
```

Proxy: `/api` and `/library` → `http://127.0.0.1:8000`

## Path alias
`@/` → `src/`

## Component library
All shadcn components are in `src/components/ui/`. 
Installed: button, card, dialog, sheet, popover, slider, select, tabs, badge, progress, input, textarea, separator, dropdown-menu, tooltip, scroll-area, label

## Key files
| File | Purpose |
|------|---------|
| `src/app/AppShell.tsx` | Notion sidebar + mobile bottom nav |
| `src/app/router.tsx` | Route definitions |
| `src/features/reader/ReaderRoute.tsx` | Kindle reader (main feature) |
| `src/features/library/LibraryRoute.tsx` | Book grid |
| `src/shared/api/client.ts` | Fetch wrapper with auth |
| `src/index.css` | All design tokens + Tailwind config |

## Fonts (self-hosted via @fontsource)
- Inter Variable — UI sans-serif
- Lora — reader body text
- Playfair Display — reader headings + book titles

## shadcn/ui note
Uses `@base-ui/react` primitives (NOT Radix UI). The `onValueChange` on Slider returns
`number | readonly number[]` — always use `Array.isArray(val) ? val[0] : val` pattern.
The `Select.onValueChange` is `(value: string | null) => void` — guard with `v != null &&`.
