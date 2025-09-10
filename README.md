# Product Viewer — React + Three.js + WebXR + USDZ (iOS)

A minimal, production-ready template to view GLB models, enter WebXR (VR & AR), and provide an iOS AR fallback via USDZ (Quick Look).

## Features

- Load `.glb/.gltf` via file picker or drag & drop
- WebXR: VR and AR
- iOS AR fallback with Quick Look (`rel="ar"` link to `.usdz`)
- Studio lighting (key/fill/rim + RoomEnvironment), soft ground shadows
- Orbit controls with auto-rotate
- Tone mapping exposure slider (ACES Filmic)
- Draco support (drop decoders in `/public/draco`)
- Vite + React + TypeScript

## Quick Start

```bash
pnpm i        # or npm i / yarn
pnpm dev      # http://localhost:5173
```

> If using npm:
>
> ```bash
> npm install
> npm run dev
> ```

Open the app, drag & drop a `.glb` model. Optionally select a `.usdz` for iOS Quick Look and tap the link shown.

### Building

```bash
pnpm build && pnpm preview
```

## Notes

- **Android AR**: Works with Chrome (WebXR + hit-test). Click **Enter AR**.
- **iOS AR**: Safari lacks WebXR (as of this template). Use the **View in AR (iOS Quick Look)** link by providing a `.usdz` file.
- **Draco**: If your GLB is Draco-compressed, copy decoders into `/public/draco`. See that folder's README.
- **HDRI**: By default we use `RoomEnvironment`. You can load an `.hdr` via `RGBELoader` if desired and set both `scene.environment` and `scene.background`.

## Where do I put my models?

Place files in `/public/assets/` (e.g. `public/assets/model.glb`), or simply drag & drop into the UI.

## License

MIT
