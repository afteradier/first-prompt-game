// ===========================================================================
// HOLLOW ROAD — a PS1-style walking-sim horror.
// Pure three.js, no build step. See README.md for how to run.
//
// Structure of this file:
//   1. Constants & seeded RNG
//   2. Renderer / low-res PS1 post pipeline
//   3. Scene, fog, lights, materials (with vertex-snap shader injection)
//   4. World generation (path, ground, fence, trees, rocks, props, lamps)
//   5. Notes & the final door
//   6. Player: pointer lock, movement, collision
//   7. Audio (ambient loops, footsteps, rare events, pickup)
//   8. Interaction & UI state machine (title / playing / reading / ended)
//   9. Main loop
// ===========================================================================

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { PS1_SNAP_CHUNK, POST_VERT, POST_FRAG } from './shaders.js';

// ---------------------------------------------------------------------------
// 1. Constants & seeded RNG
// ---------------------------------------------------------------------------

const SEED = 1987;                       // change for a different layout
const RT_WIDTH = 320, RT_HEIGHT = 240;   // PS1-ish internal resolution
const BOUND_X = 40, BOUND_Z = 80;        // playable half-extents (fenced)
const PATH_WIDTH = 3.2;
const PLAYER_RADIUS = 0.35;
const EYE_HEIGHT = 1.65;
const WALK_SPEED = 3.4;                  // m/s
const STEP_DISTANCE = 1.5;               // meters between footstep sounds
const START_GRACE = 2.0;                 // seconds of ambient-only before movement
const NOTE_COUNT = 4;
const FOG_COLOR = 0x353a36;              // desaturated gray-green

// Mulberry32 — tiny seeded PRNG so the procedural layout is reproducible.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rng = mulberry32(SEED);
const rngRange = (min, max) => min + rng() * (max - min);

// ---------------------------------------------------------------------------
// 2. Renderer + low-res render target + dithered upscale pass
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(FOG_COLOR);
document.body.appendChild(renderer.domElement);

// The whole scene renders into this tiny buffer, then gets stretched to the
// screen with NearestFilter — that's the chunky-pixel PS1 look.
const renderTarget = new THREE.WebGLRenderTarget(RT_WIDTH, RT_HEIGHT, {
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
    depthBuffer: true,
});

const postScene = new THREE.Scene();
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tDiffuse: { value: renderTarget.texture },
        uResolution: { value: new THREE.Vector2(RT_WIDTH, RT_HEIGHT) },
    },
    vertexShader: POST_VERT,
    fragmentShader: POST_FRAG,
    depthTest: false,
    depthWrite: false,
});
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));

// ---------------------------------------------------------------------------
// 3. Scene, camera, fog, lights, material helpers
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.13); // ~10 m effective visibility

const camera = new THREE.PerspectiveCamera(
    70, window.innerWidth / window.innerHeight, 0.1, 120
);

// Dim, cold base light — the lamps do the rest.
scene.add(new THREE.HemisphereLight(0x8f9a94, 0x39332a, 0.75));

// Inject the PS1 vertex-snap chunk into any material.
function applyPS1(material) {
    material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
            '#include <project_vertex>', PS1_SNAP_CHUNK
        );
    };
    return material;
}

// Small procedural canvas textures — deliberately tiny + NearestFilter +
// no mipmaps for that crunchy PS1 texel look.
function makeTexture(size, painter, repeatX = 1, repeatY = 1) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    painter(cv.getContext('2d'), size);
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function noisePaint(ctx, size, baseR, baseG, baseB, variation) {
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n = (rng() - 0.5) * 2 * variation;
            ctx.fillStyle = `rgb(${(baseR + n) | 0},${(baseG + n) | 0},${(baseB + n) | 0})`;
            ctx.fillRect(x, y, 1, 1);
        }
    }
}

const grassTex = makeTexture(64, (ctx, s) => noisePaint(ctx, s, 58, 66, 52, 14), 40, 80);
const dirtTex = makeTexture(64, (ctx, s) => noisePaint(ctx, s, 118, 104, 82, 16), 1, 60);
const plankTex = makeTexture(64, (ctx, s) => {
    noisePaint(ctx, s, 82, 72, 58, 12);
    // vertical plank seams
    ctx.fillStyle = 'rgba(20,16,12,0.65)';
    for (let x = 0; x < s; x += 8) ctx.fillRect(x, 0, 1, s);
}, 2, 1);

// Shared low-poly materials (all Lambert + vertex snapping, muted palette).
const MAT = {
    grass:   applyPS1(new THREE.MeshLambertMaterial({ map: grassTex })),
    dirt:    applyPS1(new THREE.MeshLambertMaterial({ map: dirtTex })),
    plank:   applyPS1(new THREE.MeshLambertMaterial({ map: plankTex })),
    trunk:   applyPS1(new THREE.MeshLambertMaterial({ color: 0x4a3f33 })),
    foliage: applyPS1(new THREE.MeshLambertMaterial({ color: 0x2f3b2c })),
    rock:    applyPS1(new THREE.MeshLambertMaterial({ color: 0x5b5d58 })),
    metal:   applyPS1(new THREE.MeshLambertMaterial({ color: 0x3d4245 })),
    rust:    applyPS1(new THREE.MeshLambertMaterial({ color: 0x4e4038 })),
    wood:    applyPS1(new THREE.MeshLambertMaterial({ color: 0x54483a })),
    paper:   applyPS1(new THREE.MeshLambertMaterial({
                 color: 0xd8d2bd, emissive: 0x36342b, side: THREE.DoubleSide })),
    bulb:    applyPS1(new THREE.MeshLambertMaterial({
                 color: 0xd9e6c9, emissive: 0x9aa886 })),
    door:    applyPS1(new THREE.MeshLambertMaterial({ color: 0x5a3a33 })),
};
// Invisible material for oversized interaction hitboxes (raycast-only).
const hitMat = new THREE.MeshBasicMaterial({ visible: false });

// ---------------------------------------------------------------------------
// 4. World generation
// ---------------------------------------------------------------------------

// --- Colliders --------------------------------------------------------------
// Simple 2D collision world: circles (trees, rocks, poles) and AABBs
// (bench, car). The player is a circle; resolution pushes it out.
const circleColliders = []; // { x, z, r }
const boxColliders = [];    // { minX, maxX, minZ, maxZ }

function addCircle(x, z, r) { circleColliders.push({ x, z, r }); }
function addBox(cx, cz, hx, hz) {
    boxColliders.push({ minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz });
}

// --- Winding path -----------------------------------------------------------
const waypoints = [];
{
    let x = 0;
    for (let z = BOUND_Z - 4; z >= -(BOUND_Z - 4); z -= 12) {
        waypoints.push(new THREE.Vector3(x, 0, z));
        x = THREE.MathUtils.clamp(x + rngRange(-10, 10), -24, 24);
    }
}
const pathCurve = new THREE.CatmullRomCurve3(waypoints);
const pathPoints = pathCurve.getSpacedPoints(220); // for distance checks

function distToPath(x, z) {
    let best = Infinity;
    for (const p of pathPoints) {
        const dx = x - p.x, dz = z - p.z;
        const d = dx * dx + dz * dz;
        if (d < best) best = d;
    }
    return Math.sqrt(best);
}

// Point on the path at parameter t, offset sideways by `side` meters.
function pathSpot(t, side) {
    const p = pathCurve.getPointAt(t);
    const tan = pathCurve.getTangentAt(t);
    const nx = -tan.z, nz = tan.x; // left normal in XZ
    return new THREE.Vector3(p.x + nx * side, 0, p.z + nz * side);
}

// --- Ground -----------------------------------------------------------------
const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(BOUND_X * 2 + 4, BOUND_Z * 2 + 4), MAT.grass
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// --- Path ribbon (a strip of quads following the curve, laid on the ground) -
{
    const N = 160;
    const positions = new Float32Array((N + 1) * 2 * 3);
    const uvs = new Float32Array((N + 1) * 2 * 2);
    const indices = [];
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const p = pathCurve.getPointAt(t);
        const tan = pathCurve.getTangentAt(t);
        const nx = -tan.z, nz = tan.x;
        const w = PATH_WIDTH / 2;
        positions.set([p.x + nx * w, 0.03, p.z + nz * w], i * 6);
        positions.set([p.x - nx * w, 0.03, p.z - nz * w], i * 6 + 3);
        uvs.set([0, t], i * 4);
        uvs.set([1, t], i * 4 + 2);
        if (i < N) {
            const a = i * 2;
            indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, MAT.dirt));
}

// --- Perimeter fence (instanced wall segments) -------------------------------
{
    const SEG = 4;
    const segGeo = new THREE.BoxGeometry(SEG, 2.5, 0.14);
    segGeo.translate(0, 1.25, 0);
    const placements = [];
    for (let x = -BOUND_X + SEG / 2; x < BOUND_X; x += SEG) {
        placements.push([x, BOUND_Z, 0], [x, -BOUND_Z, 0]);
    }
    for (let z = -BOUND_Z + SEG / 2; z < BOUND_Z; z += SEG) {
        placements.push([BOUND_X, z, Math.PI / 2], [-BOUND_X, z, Math.PI / 2]);
    }
    const fence = new THREE.InstancedMesh(segGeo, MAT.plank, placements.length);
    const m = new THREE.Matrix4();
    placements.forEach(([x, z, ry], i) => {
        m.makeRotationY(ry).setPosition(x, 0, z);
        fence.setMatrixAt(i, m);
    });
    scene.add(fence);
    // (No per-segment colliders — the player position is clamped to bounds.)
}

// --- Trees (two instanced meshes: trunks + foliage cones) --------------------
const treeSpots = [];
{
    const TREES = 140;
    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.28, 2.6, 5);
    trunkGeo.translate(0, 1.3, 0);
    const foliageGeo = new THREE.ConeGeometry(1.5, 3.4, 6);
    foliageGeo.translate(0, 4.1, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, MAT.trunk, TREES);
    const crowns = new THREE.InstancedMesh(foliageGeo, MAT.foliage, TREES);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let placed = 0, guard = 0;
    while (placed < TREES && guard++ < TREES * 40) {
        const x = rngRange(-BOUND_X + 2, BOUND_X - 2);
        const z = rngRange(-BOUND_Z + 2, BOUND_Z - 2);
        if (distToPath(x, z) < PATH_WIDTH / 2 + 1.8) continue;
        if (treeSpots.some(t => (t.x - x) ** 2 + (t.z - z) ** 2 < 1.8 ** 2)) continue;
        const s = rngRange(0.8, 1.7);
        q.setFromAxisAngle(up, rng() * Math.PI * 2);
        m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
        trunks.setMatrixAt(placed, m);
        crowns.setMatrixAt(placed, m);
        treeSpots.push({ x, z });
        addCircle(x, z, 0.32 * s);
        placed++;
    }
    trunks.count = crowns.count = placed;
    scene.add(trunks, crowns);
}

// --- Rocks (instanced, half-buried) ------------------------------------------
{
    const ROCKS = 45;
    const rockGeo = new THREE.DodecahedronGeometry(0.5, 0);
    const rocks = new THREE.InstancedMesh(rockGeo, MAT.rock, ROCKS);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let placed = 0, guard = 0;
    while (placed < ROCKS && guard++ < ROCKS * 40) {
        const x = rngRange(-BOUND_X + 2, BOUND_X - 2);
        const z = rngRange(-BOUND_Z + 2, BOUND_Z - 2);
        if (distToPath(x, z) < PATH_WIDTH / 2 + 0.9) continue;
        const s = rngRange(0.4, 1.3);
        e.set(rng() * 0.5, rng() * Math.PI * 2, rng() * 0.5);
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(x, s * 0.18, z), q, new THREE.Vector3(s, s * 0.7, s));
        rocks.setMatrixAt(placed, m);
        if (s > 0.7) addCircle(x, z, 0.5 * s);
        placed++;
    }
    rocks.count = placed;
    scene.add(rocks);
}

// --- Streetlamps along the path -----------------------------------------------
const lampLights = [];
{
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.1, 3.6, 6);
    poleGeo.translate(0, 1.8, 0);
    const headGeo = new THREE.BoxGeometry(0.35, 0.22, 0.35);
    for (let i = 0; i < 7; i++) {
        const t = 0.08 + i * 0.14;
        const spot = pathSpot(t, (i % 2 === 0 ? 1 : -1) * (PATH_WIDTH / 2 + 0.7));
        const pole = new THREE.Mesh(poleGeo, MAT.metal);
        pole.position.copy(spot);
        const head = new THREE.Mesh(headGeo, MAT.bulb);
        head.position.set(spot.x, 3.55, spot.z);
        // r160 uses physical light units — point lights need real intensity.
        const light = new THREE.PointLight(0xd8e6c0, 26, 12, 2);
        light.position.set(spot.x, 3.3, spot.z);
        scene.add(pole, head, light);
        // A couple of lamps get a nervous flicker; the rest just breathe.
        lampLights.push({ light, base: 26, flicker: i === 2 || i === 5 });
        addCircle(spot.x, spot.z, 0.16);
    }
}

// --- Props: a bench and a broken car ------------------------------------------
{
    // Bench beside the path.
    const spot = pathSpot(0.48, PATH_WIDTH / 2 + 1.2);
    const bench = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 0.5), MAT.wood);
    seat.position.y = 0.5;
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 0.08), MAT.wood);
    back.position.set(0, 0.85, -0.23);
    const legGeo = new THREE.BoxGeometry(0.08, 0.5, 0.45);
    const legL = new THREE.Mesh(legGeo, MAT.metal); legL.position.set(-0.75, 0.25, 0);
    const legR = new THREE.Mesh(legGeo, MAT.metal); legR.position.set(0.75, 0.25, 0);
    bench.add(seat, back, legL, legR);
    bench.position.copy(spot);
    bench.rotation.y = rng() * Math.PI * 2;
    scene.add(bench);
    addBox(spot.x, spot.z, 1.1, 1.1);
}
{
    // Abandoned car, slightly sunk and tilted.
    const spot = pathSpot(0.28, -(PATH_WIDTH / 2 + 1.6));
    const car = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.9, 1.8), MAT.rust);
    body.position.y = 0.55;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 1.6), MAT.rust);
    cabin.position.set(-0.2, 1.3, 0);
    const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.25, 8);
    wheelGeo.rotateX(Math.PI / 2);
    for (const [wx, wz] of [[-1.4, 0.95], [1.4, 0.95], [-1.4, -0.95], [1.4, -0.95]]) {
        const w = new THREE.Mesh(wheelGeo, MAT.metal);
        w.position.set(wx, 0.3, wz);
        car.add(w);
    }
    car.add(body, cabin);
    car.position.set(spot.x, -0.08, spot.z);
    car.rotation.set(0, rngRange(0.2, 0.6), 0.045);
    scene.add(car);
    addBox(spot.x, spot.z, 2.5, 2.0);
}

// ---------------------------------------------------------------------------
// 5. Notes & the final door
// ---------------------------------------------------------------------------

// HTML content for each note (styles: fragmented / trailing off / repetition /
// second person + redaction). Rendered into the paper overlay.
const NOTE_TEXTS = [
`cold again. third night.

the lamps stay lit. nobody comes to light them.

counted the fence posts on the way home. wrong number.

counted the <span class="strike">people</span> posts again.

worse.`,

`i thought it was the wind at first because the wind here sounds like breathing if you stand still long enough but on tuesday the wind stopped completely and the sound didnt it kept going under the fog low and patient and a little closer every night and tonight it is right outside the`,

`don't look back. don't look back.

it only follows what watches it.

don't look back. don't look back. don't look back.

it is very patient. it has nowhere else to be.

don't look back. don't look back. don't look back.`,

`You've been walking this street for longer than you think.

You tell yourself it's a loop. It isn't. The street is a <span class="redact">████████</span>.

By the time you found this paper, it was already <span class="redact">███ ████</span>.

Put it down. Keep walking. Don't count the lamps.

The door at the end is for you.`,
];

const interactables = []; // hit meshes; userData: { kind, index }
const paperMeshes = [];   // for the idle sway animation
const notes = [];         // { group, hit, collected }

{
    const postGeo = new THREE.BoxGeometry(0.06, 0.95, 0.06);
    postGeo.translate(0, 0.475, 0);
    const paperGeo = new THREE.PlaneGeometry(0.28, 0.38);
    const noteTs = [0.15, 0.42, 0.63, 0.85];
    for (let i = 0; i < NOTE_COUNT; i++) {
        const spot = pathSpot(noteTs[i], (i % 2 === 0 ? 1 : -1) * 1.3);
        const group = new THREE.Group();
        group.position.copy(spot);
        group.rotation.y = rng() * Math.PI * 2;

        const post = new THREE.Mesh(postGeo, MAT.wood);
        const paper = new THREE.Mesh(paperGeo, MAT.paper);
        paper.position.set(0, 0.98, 0.04);
        paper.rotation.x = -0.15;
        paperMeshes.push(paper);

        // Generous invisible hitbox so aiming at the note is forgiving.
        const hit = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), hitMat);
        hit.position.y = 0.9;
        hit.userData = { kind: 'note', index: i };

        group.add(post, paper, hit);
        scene.add(group);
        interactables.push(hit);
        notes.push({ group, hit, collected: false });
    }
}

// The door appears at the far end of the path once every note is read.
const door = new THREE.Group();
let doorLight;
{
    const spot = pathCurve.getPointAt(0.985);
    const tan = pathCurve.getTangentAt(0.985);
    door.position.set(spot.x, 0, spot.z);
    door.rotation.y = Math.atan2(tan.x, tan.z); // face back along the path

    const jambGeo = new THREE.BoxGeometry(0.18, 2.3, 0.18);
    const jambL = new THREE.Mesh(jambGeo, MAT.wood); jambL.position.set(-0.62, 1.15, 0);
    const jambR = new THREE.Mesh(jambGeo, MAT.wood); jambR.position.set(0.62, 1.15, 0);
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.18, 0.18), MAT.wood);
    lintel.position.y = 2.35;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.06, 2.2, 0.1), MAT.door);
    slab.position.y = 1.1;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), MAT.bulb);
    knob.position.set(0.38, 1.05, 0.09);

    doorLight = new THREE.PointLight(0xe8d8a8, 0, 8, 2); // off until reveal
    doorLight.position.set(0, 2.6, 0.4);

    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), hitMat);
    hit.position.y = 1.1;
    hit.userData = { kind: 'door' };

    door.add(jambL, jambR, lintel, slab, knob, doorLight, hit);
    door.visible = false;
    scene.add(door);
    // NOTE: the hitbox is NOT in `interactables` yet — three.js raycasting
    // ignores visibility, so it only becomes interactable on reveal.
    door.userData.hit = hit;
}

// ---------------------------------------------------------------------------
// 6. Player: pointer lock, movement, collision
// ---------------------------------------------------------------------------

const controls = new PointerLockControls(camera, document.body);
scene.add(controls.getObject());

// Spawn at the start of the path, looking down it.
{
    const start = pathCurve.getPointAt(0.015);
    const ahead = pathCurve.getPointAt(0.06);
    camera.position.set(start.x, EYE_HEIGHT, start.z);
    camera.lookAt(ahead.x, EYE_HEIGHT, ahead.z);
}

const keys = { w: false, a: false, s: false, d: false };
window.addEventListener('keydown', (e) => onKey(e.code, true, e));
window.addEventListener('keyup', (e) => onKey(e.code, false, e));
function onKey(code, down, e) {
    switch (code) {
        case 'KeyW': case 'ArrowUp':    keys.w = down; break;
        case 'KeyS': case 'ArrowDown':  keys.s = down; break;
        case 'KeyA': case 'ArrowLeft':  keys.a = down; break;
        case 'KeyD': case 'ArrowRight': keys.d = down; break;
        case 'KeyE': if (down) handleInteractKey(); break;
    }
}

// Push the player circle out of every collider (two passes handles corners),
// then clamp to the fenced bounds.
function resolveCollisions(pos) {
    for (let pass = 0; pass < 2; pass++) {
        for (const c of circleColliders) {
            const dx = pos.x - c.x, dz = pos.z - c.z;
            const r = c.r + PLAYER_RADIUS;
            const d2 = dx * dx + dz * dz;
            if (d2 < r * r) {
                if (d2 > 1e-8) {
                    const d = Math.sqrt(d2);
                    pos.x = c.x + (dx / d) * r;
                    pos.z = c.z + (dz / d) * r;
                } else {
                    pos.x = c.x + r; // dead-center: eject along +x
                }
            }
        }
        for (const b of boxColliders) {
            const cx = THREE.MathUtils.clamp(pos.x, b.minX, b.maxX);
            const cz = THREE.MathUtils.clamp(pos.z, b.minZ, b.maxZ);
            const dx = pos.x - cx, dz = pos.z - cz;
            const d2 = dx * dx + dz * dz;
            if (d2 < PLAYER_RADIUS * PLAYER_RADIUS) {
                if (d2 > 1e-8) {
                    const d = Math.sqrt(d2);
                    pos.x = cx + (dx / d) * PLAYER_RADIUS;
                    pos.z = cz + (dz / d) * PLAYER_RADIUS;
                } else {
                    // Center is inside the box — eject through the nearest face.
                    const outs = [
                        [b.minX - PLAYER_RADIUS - pos.x, 0],
                        [b.maxX + PLAYER_RADIUS - pos.x, 0],
                        [0, b.minZ - PLAYER_RADIUS - pos.z],
                        [0, b.maxZ + PLAYER_RADIUS - pos.z],
                    ];
                    outs.sort((p, q) =>
                        (p[0] ** 2 + p[1] ** 2) - (q[0] ** 2 + q[1] ** 2));
                    pos.x += outs[0][0]; pos.z += outs[0][1];
                }
            }
        }
    }
    pos.x = THREE.MathUtils.clamp(pos.x, -BOUND_X + 0.6, BOUND_X - 0.6);
    pos.z = THREE.MathUtils.clamp(pos.z, -BOUND_Z + 0.6, BOUND_Z - 0.6);
}

// ---------------------------------------------------------------------------
// 7. Audio
// ---------------------------------------------------------------------------

const listener = new THREE.AudioListener();
camera.add(listener);
const audioLoader = new THREE.AudioLoader();

const buffers = { steps: [] }; // filled asynchronously
let audioStarted = false;      // becomes true on the title-screen click

function loadBuffer(url, assign) {
    audioLoader.load(url, (buf) => { assign(buf); tryStartLoops(); });
}
loadBuffer('./sounds/ambient/wind-loop.mp3', b => buffers.wind = b);
loadBuffer('./sounds/ambient/dark-ambient-drone-loop.wav', b => buffers.drone = b);
loadBuffer('./sounds/creepy/horror-stinger.mp3', b => buffers.stinger = b);
loadBuffer('./sounds/creepy/deep-distant-unknown-roar.mp3', b => buffers.roar = b);
loadBuffer('./sounds/creepy/unknown-distant-steps.mp3', b => buffers.distantSteps = b);
loadBuffer('./sounds/interact/pickup-item.mp3', b => buffers.pickup = b);
for (let i = 1; i <= 21; i++) {
    const n = String(i).padStart(3, '0');
    loadBuffer(`./sounds/footsteps/Steps_dirt-${n}.ogg`,
        b => buffers.steps.push(b));
}

// Continuous background layers: quiet wind + low drone under everything.
const windAudio = new THREE.Audio(listener);
const droneAudio = new THREE.Audio(listener);
function tryStartLoops() {
    if (!audioStarted) return;
    if (buffers.wind && !windAudio.isPlaying) {
        windAudio.setBuffer(buffers.wind);
        windAudio.setLoop(true);
        windAudio.setVolume(0.22);
        windAudio.play();
    }
    if (buffers.drone && !droneAudio.isPlaying) {
        droneAudio.setBuffer(buffers.drone);
        droneAudio.setLoop(true);
        droneAudio.setVolume(0.26);
        droneAudio.play();
    }
}

// Footsteps: small round-robin pool so quick steps can overlap; never the
// same file twice in a row, with slight rate/volume randomization.
const stepPool = Array.from({ length: 4 }, () => new THREE.Audio(listener));
let stepPoolIdx = 0, lastStepIdx = -1;
function playFootstep() {
    if (!audioStarted || buffers.steps.length < 2) return;
    let i;
    do { i = Math.floor(Math.random() * buffers.steps.length); }
    while (i === lastStepIdx);
    lastStepIdx = i;
    const a = stepPool[stepPoolIdx++ % stepPool.length];
    if (a.isPlaying) a.stop();
    a.setBuffer(buffers.steps[i]);
    a.setPlaybackRate(0.9 + Math.random() * 0.2);
    a.setVolume(0.7 * (0.8 + Math.random() * 0.2));
    a.play();
}

// Rare one-shot scares, spaced 60–120 s apart, never overlapping each other.
const eventAudio = new THREE.Audio(listener);
let nextEventAt = Infinity;
let eventEndsAt = 0;
let lastEventKey = null;
function updateRareEvents(now) {
    if (!audioStarted || now < nextEventAt || now < eventEndsAt) return;
    const pool = ['stinger', 'roar', 'distantSteps']
        .filter(k => buffers[k] && k !== lastEventKey);
    if (pool.length === 0) return;
    const key = pool[Math.floor(Math.random() * pool.length)];
    lastEventKey = key;
    if (eventAudio.isPlaying) eventAudio.stop();
    eventAudio.setBuffer(buffers[key]);
    eventAudio.setVolume(0.45);
    eventAudio.play();
    eventEndsAt = now + buffers[key].duration;
    nextEventAt = eventEndsAt + 60 + Math.random() * 60;
}

const pickupAudio = new THREE.Audio(listener);
function playPickup() {
    if (!audioStarted || !buffers.pickup) return;
    if (pickupAudio.isPlaying) pickupAudio.stop();
    pickupAudio.setBuffer(buffers.pickup);
    pickupAudio.setVolume(0.8);
    pickupAudio.play();
}

// ---------------------------------------------------------------------------
// 8. Interaction & UI state machine
// ---------------------------------------------------------------------------

const ui = {
    title: document.getElementById('title'),
    pause: document.getElementById('pause'),
    hud: document.getElementById('hud'),
    counter: document.getElementById('counter'),
    prompt: document.getElementById('prompt'),
    toast: document.getElementById('toast'),
    noteOverlay: document.getElementById('noteOverlay'),
    noteText: document.getElementById('noteText'),
    fade: document.getElementById('fade'),
    endScreen: document.getElementById('endScreen'),
};

// state: 'title' | 'playing' | 'reading' | 'ended'
let state = 'title';
let notesFound = 0;
let gameStartTime = 0;     // for the 2 s ambient-only grace period
let doorRevealed = false;
let toastTimer = null;

function showToast(text, ms = 4500) {
    ui.toast.textContent = text;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

// Debug/smoke-test helper: open the page with #peek (or #peek=0.5 for a spot
// along the path) to skip the title screen and just look at the world.
// Harmless in normal play; no audio starts without a click either way.
const peek = location.hash.match(/^#peek(?:=([\d.]+))?$/);
if (peek) {
    state = 'playing';
    ui.title.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    const t = Math.min(peek[1] ? parseFloat(peek[1]) : 0.015, 0.96);
    const p = pathCurve.getPointAt(t);
    const ahead = pathCurve.getPointAt(t + 0.04);
    camera.position.set(p.x, EYE_HEIGHT, p.z);
    camera.lookAt(ahead.x, EYE_HEIGHT, ahead.z);
    // Smoke-test hook (peek mode only): lets an automated test drive the
    // note → door → ending flow without a mouse.
    window.__dbg = {
        openNote, closeNote, triggerEnding, notes, camera, pathCurve,
        resolveCollisions, circleColliders,
    };
}

// The single click that starts everything: fades the title, locks the
// pointer, resumes the AudioContext and starts the ambient loops.
ui.title.addEventListener('click', () => {
    if (state !== 'title') return;
    state = 'playing';
    gameStartTime = clock.elapsedTime;
    nextEventAt = gameStartTime + 40 + Math.random() * 40;
    ui.title.classList.add('fading');
    ui.hud.classList.remove('hidden');
    setTimeout(() => ui.title.classList.add('hidden'), 1300);
    listener.context.resume();
    audioStarted = true;
    tryStartLoops();
    controls.lock();
});

ui.pause.addEventListener('click', () => {
    if (state === 'playing' || state === 'reading') controls.lock();
});

controls.addEventListener('lock', () => ui.pause.classList.add('hidden'));
controls.addEventListener('unlock', () => {
    if (state === 'playing' || state === 'reading') {
        ui.pause.classList.remove('hidden');
    }
});

// Center-screen raycast against interactable hitboxes.
const raycaster = new THREE.Raycaster();
raycaster.far = 2.6;
let aimedAt = null; // hit mesh currently under the crosshair, or null
function updateAim() {
    aimedAt = null;
    if (state !== 'playing') { ui.prompt.classList.add('hidden'); return; }
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const hits = raycaster.intersectObjects(interactables, false);
    if (hits.length > 0) {
        aimedAt = hits[0].object;
        ui.prompt.textContent = aimedAt.userData.kind === 'door'
            ? '[ E ]  open the door'
            : '[ E ]  read the note';
        ui.prompt.classList.remove('hidden');
    } else {
        ui.prompt.classList.add('hidden');
    }
}

function handleInteractKey() {
    if (state === 'reading') { closeNote(); return; }
    if (state !== 'playing' || !aimedAt) return;
    const { kind, index } = aimedAt.userData;
    if (kind === 'note') openNote(index);
    else if (kind === 'door') triggerEnding();
}

function openNote(index) {
    const note = notes[index];
    ui.noteText.innerHTML = NOTE_TEXTS[index];
    ui.noteOverlay.classList.remove('hidden');
    ui.prompt.classList.add('hidden');
    state = 'reading';
    if (!note.collected) {
        note.collected = true;
        notesFound++;
        ui.counter.textContent = `NOTES FOUND: ${notesFound}/${NOTE_COUNT}`;
        playPickup();
        // The physical note is taken; remove it from the world.
        scene.remove(note.group);
        interactables.splice(interactables.indexOf(note.hit), 1);
    }
}

function closeNote() {
    ui.noteOverlay.classList.add('hidden');
    state = 'playing';
    if (notesFound >= NOTE_COUNT && !doorRevealed) {
        doorRevealed = true;
        door.visible = true;
        doorLight.intensity = 10;
        interactables.push(door.userData.hit);
        showToast('something waits at the end of the road.');
    }
}

function triggerEnding() {
    state = 'ended';
    ui.prompt.classList.add('hidden');
    ui.fade.classList.add('on');
    setTimeout(() => {
        ui.endScreen.classList.add('on');
        controls.unlock();
        ui.pause.classList.add('hidden');
        ui.hud.classList.add('hidden');
    }, 3000);
}

// ---------------------------------------------------------------------------
// 9. Main loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
let stepAccum = 0;   // distance walked since the last footstep sound
let bobPhase = 0;    // head-bob oscillator, driven by distance walked

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const now = clock.elapsedTime;

    // --- Movement (only while playing, pointer locked, past the grace pause)
    const canMove = state === 'playing' && controls.isLocked
        && (now - gameStartTime) > START_GRACE;
    if (canMove) {
        const fwd = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
        const strafe = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
        if (fwd !== 0 || strafe !== 0) {
            const inv = 1 / Math.hypot(fwd, strafe);
            const prevX = camera.position.x, prevZ = camera.position.z;
            controls.moveForward(fwd * inv * WALK_SPEED * dt);
            controls.moveRight(strafe * inv * WALK_SPEED * dt);
            resolveCollisions(camera.position);
            const moved = Math.hypot(
                camera.position.x - prevX, camera.position.z - prevZ);
            stepAccum += moved;
            bobPhase += moved * 2.1;
            if (stepAccum >= STEP_DISTANCE) {
                stepAccum = 0;
                playFootstep();
            }
        }
        camera.position.y = EYE_HEIGHT + Math.sin(bobPhase) * 0.035;
    }

    // --- Ambience
    updateRareEvents(now);
    for (const l of lampLights) {
        l.light.intensity = l.flicker
            ? l.base * (Math.random() < 0.06 ? 0.15 : 0.9 + Math.random() * 0.15)
            : l.base * (0.95 + 0.05 * Math.sin(now * 2.3 + l.light.position.x));
    }
    if (doorRevealed && state !== 'ended') {
        doorLight.intensity = 10 * (0.85 + 0.15 * Math.sin(now * 7.1));
    }
    // Papers sway faintly on their posts.
    for (let i = 0; i < paperMeshes.length; i++) {
        paperMeshes[i].rotation.z = Math.sin(now * 1.3 + i * 2.1) * 0.06;
    }
    // Let the world go quiet under the end screen.
    if (state === 'ended') {
        const v = Math.max(0.05, listener.getMasterVolume() - dt * 0.15);
        listener.setMasterVolume(v);
    }

    updateAim();

    // --- Render: scene → tiny target → dithered fullscreen upscale
    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();
