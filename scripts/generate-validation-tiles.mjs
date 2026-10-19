import { mkdir, writeFile } from 'node:fs/promises'

// Synthetic fixture only: this mesh is not an output of photogrammetry.
const output = new URL('../public/validation/', import.meta.url)
const origin = { longitude: 116.391, latitude: 39.906, altitude: 0 }
const longitude = origin.longitude * Math.PI / 180
const latitude = origin.latitude * Math.PI / 180
const sinLon = Math.sin(longitude)
const cosLon = Math.cos(longitude)
const sinLat = Math.sin(latitude)
const cosLat = Math.cos(latitude)
const flattening = 1 / 298.257223563
const eccentricitySquared = flattening * (2 - flattening)
const radius = 6378137 / Math.sqrt(1 - eccentricitySquared * sinLat * sinLat)
const translation = [
  (radius + origin.altitude) * cosLat * cosLon,
  (radius + origin.altitude) * cosLat * sinLon,
  (radius * (1 - eccentricitySquared) + origin.altitude) * sinLat,
]
// Column-major ENU -> ECEF. glTF Y-up is converted to tile Z-up by the loader.
const transform = [
  -sinLon, cosLon, 0, 0,
  -sinLat * cosLon, -sinLat * sinLon, cosLat, 0,
  cosLat * cosLon, cosLat * sinLon, sinLat, 0,
  ...translation, 1,
]

// Outward counterclockwise faces in local ENU meters.
const faces = [
  { name: 'east', normal: [1, 0, 0], color: [0.12, 0.45, 0.74, 1],
    vertices: [[9, -6, 0], [9, 6, 0], [9, 6, 16], [9, -6, 16]] },
  { name: 'west', normal: [-1, 0, 0], color: [0.85, 0.32, 0.1, 1],
    vertices: [[-9, 6, 0], [-9, -6, 0], [-9, -6, 16], [-9, 6, 16]] },
  { name: 'north', normal: [0, 1, 0], color: [0.1, 0.58, 0.4, 1],
    vertices: [[9, 6, 0], [-9, 6, 0], [-9, 6, 16], [9, 6, 16]] },
  { name: 'south', normal: [0, -1, 0], color: [0.5, 0.2, 0.7, 1],
    vertices: [[-9, -6, 0], [9, -6, 0], [9, -6, 16], [-9, -6, 16]] },
  { name: 'roof', normal: [0, 0, 1], color: [0.8, 0.65, 0.2, 1],
    vertices: [[-9, -6, 16], [9, -6, 16], [9, 6, 16], [-9, 6, 16]] },
  { name: 'base', normal: [0, 0, -1], color: [0.2, 0.22, 0.25, 1],
    vertices: [[-9, 6, 0], [9, 6, 0], [9, -6, 0], [-9, -6, 0]] },
]
// Cesium's glTF Y-up -> 3D Tiles Z-up mapping is (x, y, z) -> (x, -z, y).
// Therefore ENU (east, north, up) is encoded as glTF (east, up, -north).
const toGltf = ([east, north, up]) => [east, up, -north]
const positions = faces.flatMap((face) => face.vertices.flatMap(toGltf))
const normals = faces.flatMap((face) => face.vertices.flatMap(() => toGltf(face.normal)))
const colors = faces.flatMap((face) => face.vertices.flatMap(() => face.color))
const indices = faces.flatMap((_, faceIndex) => [0, 1, 2, 0, 2, 3].map((index) => index + faceIndex * 4))
const parts = [new Float32Array(positions), new Float32Array(normals), new Float32Array(colors), new Uint16Array(indices)]
const buffer = Buffer.concat(parts.map((part) => Buffer.from(part.buffer)))
let byteOffset = 0
const bufferViews = parts.map((part, index) => {
  const view = { buffer: 0, byteOffset, byteLength: part.byteLength, target: index === 3 ? 34963 : 34962 }
  byteOffset += part.byteLength
  return view
})
const syntheticNotice = 'Synthetic loading fixture only; not a photogrammetry reconstruction.'
const gltf = {
  asset: { version: '2.0', generator: 'drone-camera validation fixture generator', copyright: syntheticNotice },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'Synthetic 18 x 12 x 16 m building', mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
  materials: [{ name: 'Face colors', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.85 } }],
  buffers: [{ byteLength: buffer.byteLength, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
  bufferViews,
  accessors: [
    { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-9, 0, -6], max: [9, 16, 6] },
    { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: 24, type: 'VEC4' },
    { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR', min: [0], max: [23] },
  ],
  extras: { notice: syntheticNotice, origin, dimensionsEnuMeters: [18, 12, 16], sourceEnuBounds: { min: [-9, -6, 0], max: [9, 6, 16] } },
}
const tileset = {
  asset: { version: '1.1', tilesetVersion: 'synthetic-validation-1' },
  // Error when the entire tileset is omitted, not the leaf's mesh error.
  // Cesium skips traversal for a zero tileset error, even if the root has content.
  geometricError: 32,
  root: {
    boundingVolume: { box: [0, 0, 8, 9, 0, 0, 0, 6, 0, 0, 0, 8] },
    geometricError: 0,
    refine: 'ADD',
    transform,
    content: { uri: 'building.gltf' },
  },
  extras: { notice: syntheticNotice, origin },
}

await mkdir(output, { recursive: true })
await writeFile(new URL('building.gltf', output), `${JSON.stringify(gltf, null, 2)}\n`)
await writeFile(new URL('tileset.json', output), `${JSON.stringify(tileset, null, 2)}\n`)
console.log(`Generated synthetic 3D Tiles fixture: ${buffer.byteLength} embedded binary bytes.`)
