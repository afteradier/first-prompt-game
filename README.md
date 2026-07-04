# HOLLOW ROAD

A short PS1-style first-person walking-sim horror (Silent Hill 1 vibes), built
with plain **three.js** and vanilla JavaScript. No build step, no dependencies
to install.

Walk the fogbound road, find the **4 notes**, and when the last one is read…
something appears at the end of the path.

There are no enemies and no fail state — the dread is in the fog, the sound,
and the writing.

## Run it

The game must be served over HTTP (audio files and ES modules don't load from
`file://`). From this folder, run any static server, e.g.:

```bash
python3 -m http.server 8000
# or: npx serve .
```

Then open http://localhost:8000 in a browser and click to begin.

> three.js is vendored in `lib/`, so the game itself works fully offline.
> Only the "Special Elite" typewriter font for the notes comes from a CDN —
> without internet the notes gracefully fall back to Courier New.

## Controls

| Key   | Action            |
|-------|-------------------|
| WASD  | move              |
| Mouse | look              |
| E     | interact / close  |
| Esc   | release the mouse |

## Project layout

```
index.html   — page, UI overlays (title / notes / HUD / ending), CSS
main.js      — game: world generation, controls, collision, audio, interaction
shaders.js   — GLSL: PS1 vertex snapping + Bayer-dither upscale pass
lib/         — vendored three.js r160 + PointerLockControls
sounds/      — ambient loops, footsteps, rare scares, pickup sound
```

## PS1 tricks used

- Scene rendered to a **320×240** target and upscaled with `NearestFilter`
- **Vertex snapping** in a custom vertex-shader chunk (the PS1 "wobble")
- 4×4 **Bayer ordered dithering** + 32-level color quantization in the
  upscale pass
- `FogExp2` tuned to ~10 m visibility, desaturated palette, tiny
  nearest-filtered procedural textures with mipmaps disabled
- `InstancedMesh` for trees, rocks and the perimeter fence; the layout is
  scattered procedurally from a fixed seed (change `SEED` in `main.js` for a
  new street)
