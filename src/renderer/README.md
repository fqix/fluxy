# Renderer frontend

The Electron renderer is a React + TypeScript frontend built with Vite, Tailwind CSS v4 and locally maintained shadcn/ui components. Run the root `npm run dev` command for the desktop development environment.

```text
src/renderer/
├── index.html
└── src/
    ├── main.tsx                 # React entry point
    ├── app/App.tsx              # Desktop application shell and screen composition
    ├── components/
    │   ├── ui/                  # shadcn primitives: Button, Input, Textarea
    │   ├── layout/              # Reusable windows and layout components
    │   └── data/                # Reusable data presentation
    ├── features/                # Business UI grouped by domain
    │   ├── breakpoints/
    │   ├── capture/
    │   ├── diff/
    │   ├── filters/
    │   ├── onboarding/
    │   ├── tools/
    │   ├── traffic/
    │   └── updates/
    ├── hooks/                   # React hooks, including worker-backed filtering
    ├── lib/                     # Frontend helpers such as cn()
    ├── styles/
    │   ├── globals.css          # Tailwind imports and shadcn theme tokens
    │   └── app.css              # Desktop layout and feature-specific styling
    ├── types/                   # Frontend types and the preload API declaration
    └── workers/                 # Web Worker entry points
```

## Imports and boundaries

- `@/` points to `src/renderer/src`.
- `@shared/` points to the browser-safe shared models and protocol utilities in `src/shared`.
- `@assets/` points to `resources`, shared with Electron packaging.
- Renderer code uses `window.fluxy` to access the typed preload API. Keep filesystem, process and other privileged operations in the main process.
- Business features use the shared UI components; keep reusable components independent of feature modules.

## UI components and styling

`components.json` at the repository root configures shadcn/ui. Components come from the official `new-york-v4` registry and are adapted to Fluxy's compact desktop sizing. Add components through the shadcn CLI from the repository root, then keep renderer-only npm dependencies in `devDependencies` so the full packages are not copied into release installers.

Tailwind runs only in the renderer build. Semantic shadcn color tokens refer to Fluxy's existing theme variables, including dark and system modes. Tailwind Preflight is intentionally omitted because the existing desktop stylesheet supplies the base styles. Use Tailwind utilities for component styles and keep application-specific pane/table layouts in `styles/app.css`.

React and the UI libraries are bundled by Vite. Production packages include compiled assets and dependency notices; they omit duplicate renderer npm packages and source maps.
