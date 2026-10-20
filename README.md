<div align="center">

# drone-camera

**A framework-agnostic drone control library for the browser — one flight core, two renderers (three.js & CesiumJS).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](./tsconfig.lib.json)
![three.js](https://img.shields.io/badge/three.js-%3E%3D0.180-black)
![CesiumJS](https://img.shields.io/badge/CesiumJS-compatible-6CADDF)

**▶ [Live demo](https://chenlong2019.github.io/drone-camera/)** — three.js & CesiumJS backends, panorama, mission editing, all in the browser.

[中文文档](./README.zh-CN.md)

</div>

<table>
<tr>
<td width="50%"><img src="docs/images/three-follow.jpg" alt="three.js backend: follow camera, flight panel, mini-map" /></td>
<td width="50%"><img src="docs/images/cesium-mission.jpg" alt="Cesium backend: real-Earth mission editing over satellite imagery" /></td>
</tr>
<tr>
<td align="center"><sub><b>three.js</b> — follow camera, flight panel, mini-map (local sandbox)</sub></td>
<td align="center"><sub><b>CesiumJS</b> — real-Earth coordinates (ENU/ECEF), in-scene waypoint editing</sub></td>
</tr>
</table>

## Why

Browser drone simulators exist. GIS drones on a 3D globe exist. **One flight core driving both — with a complete camera-to-panorama pipeline — does not.** drone-camera fills that gap:

- **One core, two renderers** — the same `DroneSim` flight-state machine (physics, battery, failsafes, geofence, obstacle AABB) drives a three.js WebGPU sandbox *and* a CesiumJS real-Earth backend. Switch backends with a single option; panels, mission editor and mini-map don't change.
- **Zero-dependency core** — `drone-sim` runs in Node or a Web Worker with no DOM, no three, no browser. Test your flight logic headlessly.
- **Complete imaging pipeline** — photo/video capture with camera intrinsics, automated panorama flights (wide / 180° / full 360°), pose-based stitching (no feature matching, no OpenCV), an equirectangular viewer, and a capture gallery with EXIF/GPS import for real photos.
- **AI-ready** — an MCP server exposes 14 `drone_*` tools so an AI agent can fly the drone, edit missions, and take photos. Headless driver included.
- **Framework-free UI** — panels are plain DOM (Vue/React/svelte/no-framework, all fine). The library itself imports nothing from any UI framework.

## Install

```sh
npm install drone-camera three
# TypeScript users:
npm install -D @types/three
```

> three.js is a **peer dependency** and stays external in ESM builds, so you never get two copies of three on one page. A UMD build with three bundled is also included (`index.umd.cjs`, exposes `window.DroneControl`).

## Quick start (three.js)

```ts
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createDroneControl, DroneControlPanel } from 'drone-camera'

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 4000)
const renderer = new WebGPURenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
const controls = new OrbitControls(camera, renderer.domElement)

// Assembles physics core + vehicle rig + gimbal + night LED lights + ranging radar.
// No modelUrl → built-in procedural quadcopter (zero assets required).
const drone = await createDroneControl({ engine: 'three', scene, camera, renderer, controls })

// Native DOM panel: arm/takeoff/land, sticks, flight modes, camera views, photo & video.
new DroneControlPanel(drone)

renderer.setAnimationLoop(() => {
  drone.animate()
  if (drone.isOrbitView) controls.update()
  drone.captureRecordingFrame()   // gimbal framing for photo/video, no-op otherwise
  drone.onBeforeRender()
  renderer.render(scene, camera)
  drone.onAfterRender()
})
```

Orbit around it, switch to FPV, gimbal it, take a photo — all from the panel. Keyboard flight is built in.

## Switch to CesiumJS (same code, real Earth)

```ts
import { createDroneControl, loadCesiumScript } from 'drone-camera'

await loadCesiumScript('/Cesium/Cesium.js')

// ENU/ECEF earth coordinates; origin altitude auto-sampled from terrain
const drone = await createDroneControl({ engine: 'cesium', viewer, lon: 116.391, lat: 39.906 })

// Same panels — new DroneControlPanel(drone) works unchanged.
```

## Features

| | |
|---|---|
| ✈️ Flight core | State machine (disarmed → armed → takeoff → flight → RTH → land), battery model, failsafes, altitude/distance ceilings, obstacle AABB avoidance, event log |
| 🎮 Control | Stick normalization, keyboard control, motion/normal modes, speed & attitude limits |
| 🛰 Backends | `three` (WebGPU sandbox) and `cesium` (real Earth) behind one interface — `createDroneControl({ engine })` |
| 🧊 Vehicle | Procedural built-in quadcopter or any GLB; arms/props/gimbal driven by semantic node names; night LED lights; ranging radar |
| 📷 Capture | Photo & video with camera pose + intrinsics, gimbal framing, capture sessions |
| 🌏 Panorama | Auto flight patterns (wide 9-shot / 180° 21-shot / 360°), pose-based stitching to equirectangular, spherical WebGL viewer |
| 🗺 Missions | In-scene waypoint editing (drag / Shift-altitude / insert / delete), execution, JSON/CSV/Manifest export |
| 🖥 UI | Plain-DOM flight panel, mission panel, capture panel, mini-map, gallery popups — mount anywhere |
| 🤖 AI | MCP server with 14 tools + headless CLI driver for scripted/agent flights |

## Panorama in three lines

```ts
import { CaptureService, PanoramaCapture } from 'drone-camera'

const capture = new CaptureService({ provider: drone })   // drone = your engine host
const session = capture.createSession({ source: 'virtual-camera', name: 'Around the tower' })
const pano = new PanoramaCapture(capture)
await pano.start(session.id, 'pano-360')   // body spins for yaw, gimbal stacks pitch rows
```

Stitching exploits the fact that every shot's camera pose is known exactly — images are back-projected onto the equirectangular canvas, no feature matching or OpenCV involved.

## Documentation

Full API reference, generated from the library's own `.d.ts`:

- `docs/` route in the demo app — usage guide
- `api-docs/` route — **1088 documented members** across 24 modules
- `class-map/` route — interactive architecture map (Vue Flow)

## Demo

```sh
npm install
npm run dev          # → /three-demo  /cesium-demo  /docs  /api-docs
```

## AI agent mode (MCP)

The repo ships `mcp/drone-mcp-server.mjs` — a stdio MCP server exposing the running demo to an AI agent: take off, fly waypoints, edit missions, gimbal, shoot panoramas, read radar, screenshot. Wire it into any MCP client and let the model fly.

## Architecture

```
┌───────────────────────── UI (plain DOM, framework-free) ─────────────────────────┐
│   DroneControlPanel  MissionPanel      CapturePanel       MiniMap   Gallery   │
└──────────────────────────────────────┬───────────────────────────────────────────┘
                                       │ host interfaces (not inheritance)
┌──────────────────────────────────────┴───────────────────────────────────────────┐
│              createDroneControl({ engine: 'three' | 'cesium' })                   │
├──────────────────────────────┬────────────────────────────────────────────────────┤
│  DroneFly (three.js/WebGPU)  │  CesiumDroneAdapter (ENU/ECEF real Earth)           │
├──────────────────────────────┴────────────────────────────────────────────────────┤
│  DroneSim — zero-dependency flight core (Node / Worker / browser)                 │
└───────────────────────────────────────────────────────────────────────────────────┘
```

## License

[MIT](./LICENSE)
