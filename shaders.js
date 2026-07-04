// ---------------------------------------------------------------------------
// shaders.js — GLSL sources for the PS1 look.
//
// Two pieces live here:
//   1. PS1_SNAP_CHUNK  — injected into every scene material's vertex shader
//      (via onBeforeCompile) right after three.js projects the vertex.
//      It quantizes clip-space positions to a coarse virtual grid, which is
//      what produced the famous "wobbly vertices" on real PS1 hardware
//      (the console had no sub-pixel vertex precision).
//   2. POST_VERT / POST_FRAG — the fullscreen upscale pass. The scene is
//      rendered to a tiny 320x240 target; this pass stretches it to the
//      screen with nearest filtering and applies a 4x4 Bayer ordered dither
//      + color quantization to fake the limited color depth of the era.
// ---------------------------------------------------------------------------

// Snap resolution is intentionally lower than the render target so the
// wobble is clearly visible. (Half of 320x240.)
export const PS1_SNAP_CHUNK = /* glsl */ `
#include <project_vertex>
{
    // Quantize the projected vertex to a coarse screen grid (PS1 wobble).
    vec4 snapped = gl_Position;
    snapped.xyz /= snapped.w;                     // to NDC
    vec2 grid = vec2(160.0, 120.0);
    snapped.xy = floor(snapped.xy * grid + 0.5) / grid;
    snapped.xyz *= snapped.w;                     // back to clip space
    gl_Position = snapped;
}
`;

export const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    // The quad is already a fullscreen [-1,1] plane; no projection needed.
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const POST_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;   // the low-res scene render
uniform vec2 uResolution;     // low-res target size (e.g. 320x240)
varying vec2 vUv;

// 2x2 Bayer cell value (0..3) for p with components in {0,1}.
float bayer2(vec2 p) {
    return 3.0 * p.y + 2.0 * p.x - 4.0 * p.x * p.y;
}

// Full 4x4 Bayer threshold in (0,1), built recursively from the 2x2 cell.
float bayer4(vec2 pix) {
    float fine   = bayer2(mod(pix, 2.0));
    float coarse = bayer2(mod(floor(pix * 0.5), 2.0));
    return (4.0 * fine + coarse + 0.5) / 16.0;
}

void main() {
    vec3 color = texture2D(tDiffuse, vUv).rgb;

    // The offscreen target holds LINEAR color (three.js only applies the
    // sRGB output transform to the default framebuffer), so gamma-encode
    // here — and dither AFTER gamma, on display-space values.
    color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));

    // Dither pattern is anchored to the LOW-RES pixel grid, so the dots
    // stay chunky after upscaling instead of being screen-resolution fine.
    vec2 pix = floor(vUv * uResolution);
    float threshold = bayer4(pix);

    // Quantize each channel to 32 levels, using the Bayer threshold to
    // decide rounding — classic ordered dithering.
    color = floor(color * 31.0 + threshold) / 31.0;

    gl_FragColor = vec4(color, 1.0);
}
`;
