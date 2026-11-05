// Ported from img2threejs/preview park-v3 scene source.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import plan from './campus-plan.json';
import { createArchitectureKit } from './campusArchitecture';

type V3 = [number, number, number];

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    return (state >>> 0) / 4294967296;
  };
}

function grain(seed: number, amount: number, tiled = false) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const context = canvas.getContext('2d')!;
  const pixels = context.createImageData(512, 512);
  const rng = random(seed);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const value = 255 - rng() * amount;
    pixels.data.set([value, value, value, 255], i);
  }
  context.putImageData(pixels, 0, 0);
  if (tiled) {
    context.strokeStyle = 'rgba(105,125,148,0.21)';
    context.lineWidth = 1.5;
    context.strokeRect(0, 0, 512, 512);
    context.strokeStyle = 'rgba(105,125,148,0.055)';
    context.lineWidth = 1;
    for (let i = 64; i < 512; i += 64) {
      context.beginPath(); context.moveTo(i, 0); context.lineTo(i, 512); context.stroke();
      context.beginPath(); context.moveTo(0, i); context.lineTo(512, i); context.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

export function createCampusModel(options: { vegetationDetail?: 'full' | 'flight' } = {}) {
  const flightDetail = options.vegetationDetail === 'flight';
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const root = new THREE.Group();
  root.name = 'digital-campus';
  const parts: Record<string, THREE.Group> = {};
  const grassMap = grain(17, 32);
  const pavingMap = grain(29, 9, true);
  const asphaltMap = grain(31, 28);
  const white = new THREE.MeshStandardMaterial({ name: 'white-panels', color: '#e6eaf1', roughness: 0.65 });
  const roof = new THREE.MeshStandardMaterial({ name: 'white-roof', color: '#edf1f5', roughness: 0.87 });
  const roofDark = new THREE.MeshStandardMaterial({ name: 'roof-membrane', color: '#7a879a', roughness: 0.9 });
  const seam = new THREE.MeshStandardMaterial({ name: 'panel-seams', color: '#bac4d2', roughness: 0.85 });
  const frame = new THREE.MeshStandardMaterial({ name: 'aluminium-frames', color: '#aabeca', metalness: 0.48, roughness: 0.31 });
  const darkFrame = new THREE.MeshStandardMaterial({ name: 'dark-frames', color: '#395166', metalness: 0.3, roughness: 0.42 });
  const roofEquipment = new THREE.MeshStandardMaterial({ name: 'roof-equipment', color: '#9faaba', roughness: 0.73 });
  const grass = new THREE.MeshStandardMaterial({ name: 'lawn-grass', color: '#5d9838', map: grassMap, roughness: 1 });
  const sidewalk = new THREE.MeshStandardMaterial({ name: 'paving', color: '#e3e7ef', map: pavingMap, roughness: 0.95 });
  const curb = new THREE.MeshStandardMaterial({ name: 'curb', color: '#c5cedb', roughness: 0.85 });
  const asphalt = new THREE.MeshStandardMaterial({ name: 'asphalt', color: '#596579', map: asphaltMap, roughness: 0.97 });
  const roadWhite = new THREE.MeshStandardMaterial({ name: 'white-marking', color: '#f3f2ec', roughness: 0.9 });
  const yellow = new THREE.MeshStandardMaterial({ name: 'yellow-marking', color: '#dbbf73', roughness: 0.85 });
  const glass = Array.from({ length: 9 }, (_, i) => new THREE.MeshPhysicalMaterial({
    name: `glazing-${i}`, color: new THREE.Color('#477a99').multiplyScalar(0.8 + i * 0.035),
    roughness: 0.14 + i * 0.006, metalness: 0.27, ior: 1.5,
    clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.4,
  }));

  function group(id: string, label: string, parent: THREE.Object3D = root) {
    const value = new THREE.Group(); value.name = id;
    value.userData.label = label; value.userData.partId = id;
    value.userData.home = [0, 0, 0];
    value.userData.actionProfile = { pivot: 'base', selectable: true, static: true };
    parent.add(value); parts[id] = value;
    return value;
  }

  function box(parent: THREE.Object3D, size: V3, position: V3, material: THREE.Material) {
    const mesh = new THREE.Mesh(boxGeometry, material);
    mesh.position.set(...position); mesh.scale.set(...size);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function slab(parent: THREE.Object3D, x: number, z: number, width: number, depth: number, y: number, height: number, radius: number, material: THREE.Material) {
    const s = new THREE.Shape();
    const a = -width / 2, b = -depth / 2, r = Math.min(radius, width / 2, depth / 2);
    s.moveTo(a + r, b); s.lineTo(-a - r, b);
    if (r > 0) s.absarc(-a - r, b + r, r, -Math.PI / 2, 0, false);
    s.lineTo(-a, -b - r);
    if (r > 0) s.absarc(-a - r, -b - r, r, 0, Math.PI / 2, false);
    s.lineTo(a + r, -b);
    if (r > 0) s.absarc(a + r, -b - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(a, b + r);
    if (r > 0) s.absarc(a + r, b + r, r, Math.PI, Math.PI * 1.5, false);
    s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: 8 });
    geo.rotateX(-Math.PI / 2);
    const p = geo.getAttribute('position'), uv = geo.getAttribute('uv');
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + x) / 8, (p.getZ(i) + z) / 8);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z); mesh.receiveShadow = true; mesh.castShadow = false;
    parent.add(mesh); return mesh;
  }

  // Bake repeated facade members per material while retaining one selectable group per building.
  function batch(target: THREE.Group) {
    target.updateMatrixWorld(true);
    const inverse = target.matrixWorld.clone().invert();
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    target.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || node instanceof THREE.InstancedMesh) return;
      const geometry = node.geometry.clone();
      if (!geometry.index) geometry.setIndex(Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i));
      geometry.applyMatrix4(inverse.clone().multiply(node.matrixWorld));
      const material = node.material as THREE.Material;
      if (!buckets.has(material)) buckets.set(material, []);
      buckets.get(material)!.push(geometry);
    });
    target.clear();
    for (const [material, geometries] of buckets) {
      let vertexOffset = 0, indexOffset = 0;
      const primitiveRanges = geometries.map((geo) => {
        const vertices = geo.getAttribute('position').count;
        const indices = geo.index?.count ?? vertices;
        const range = { vertexOffset, indexOffset, vertices, indices };
        vertexOffset += vertices; indexOffset += indices;
        return range;
      });
      const merged = mergeGeometries(geometries, false)!;
      geometries.forEach((item) => item.dispose());
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${target.name}:${material.name}`;
      mesh.userData.partId = target.name;
      mesh.userData.explodeWithParent = true;
      mesh.userData.primitiveRanges = primitiveRanges;
      mesh.castShadow = !material.transparent;
      mesh.receiveShadow = true;
      target.add(mesh);
    }
  }

  const terrain = group('terrain', '周边地块');
  slab(terrain, 0, 0, 1600, 1600, -0.14, 0.12, 0, sidewalk);
  const terrainMesh = terrain.children[0] as THREE.Mesh;
  terrainMesh.name = 'terrain:paving';
  terrainMesh.userData.partId = 'terrain';
  const tUV = terrainMesh.geometry.getAttribute('uv');
  for (let i = 0; i < tUV.count; i++) tUV.setXY(i, tUV.getX(i) / 2.5, tUV.getY(i) / 2.5);
  const roads = group('roads', '道路与斑马线');
  const roadDefs = [...plan.roads,
    { id: 'far-north', axis: 'x', at: -258, start: -700, end: 700, width: 14 },
    { id: 'far-north-2', axis: 'x', at: -410, start: -700, end: 700, width: 14 },
    { id: 'far-east', axis: 'z', at: 290, start: -600, end: 600, width: 14 },
    { id: 'far-west', axis: 'z', at: -295, start: -600, end: 600, width: 14 },
  ];
  for (const road of roadDefs) {
    const horizontal = road.axis === 'x';
    const mid = (road.start + road.end) / 2, length = road.end - road.start;
    slab(roads, horizontal ? mid : road.at, horizontal ? road.at : mid,
      horizontal ? length : road.width, horizontal ? road.width : length, 0, 0.035, 0, asphalt);
    const intersects = roadDefs.filter((other) => other.axis !== road.axis && other.at > road.start && other.at < road.end && road.at >= other.start && road.at <= other.end);
    for (let p = road.start + 3; p < road.end - 3; p += 9) {
      if (intersects.some((other) => Math.abs(other.at - p) < other.width / 2 + 5)) continue;
      const size: V3 = horizontal ? [4, 0.016, 0.15] : [0.15, 0.016, 4];
      box(roads, size, horizontal ? [p, 0.055, road.at] : [road.at, 0.055, p], road.width > 10 ? yellow : roadWhite);
      if (road.width > 10) for (const sign of [-1, 1]) {
        box(roads, size, horizontal ? [p, 0.055, road.at + sign * 4] : [road.at + sign * 4, 0.055, p], roadWhite);
      }
    }
    for (const other of intersects) {
      if (Math.abs(other.at) > 310 || Math.abs(road.at) > 270) continue;
      for (const side of [-1, 1]) {
        const at = other.at + side * (other.width / 2 + 3.2);
        for (let lane = -road.width / 2 + 0.8; lane <= road.width / 2 - 0.8; lane += 1.05) {
          box(roads, horizontal ? [3.4, 0.018, 0.5] : [0.5, 0.018, 3.4],
            horizontal ? [at, 0.058, road.at + lane] : [road.at + lane, 0.058, at], roadWhite);
        }
      }
    }
  }

  const paving = group('paving', '人行道与建筑广场');
  slab(paving, -80, 0, 82, 199, 0.04, 0.2, 3, curb);
  slab(paving, -80, 0, 81.4, 198.4, 0.24, 0.04, 2.8, sidewalk);
  slab(paving, 45, -70, 150, 65, 0.04, 0.2, 3.5, curb);
  slab(paving, 45, -70, 149.4, 64.4, 0.24, 0.04, 3.2, sidewalk);
  const lawn = group('lawn', '中央庭院与草坪');
  const l = plan.lawn;
  slab(lawn, l.x, l.z, l.width + 6, l.depth + 6, 0.04, 0.23, 5.5, curb);
  slab(lawn, l.x, l.z, l.width + 5.4, l.depth + 5.4, 0.27, 0.025, 5.2, sidewalk);
  slab(lawn, l.x, l.z, l.width, l.depth, 0.295, 0.1, 4, grass);
  for (const [x, z, w, d] of plan.landscape.paths) {
    if (x === undefined || z === undefined || w === undefined || d === undefined) continue;
    slab(lawn, x, z, w, d, 0.396, 0.025, 0, sidewalk);
  }
  const planting = group('planting', '建筑绿化带');
  for (const [x, z, w, d] of [[-119, 0, 3, 190], [-42, 0, 4, 190], [0, 96, 223, 4], [48, -43, 126, 5], [120, 0, 3, 190], [0, -97, 224, 4], [53, 35, 49, 38]] as const) {
    slab(planting, x, z, w, d, 0.29, 0.1, 2, grass);
  }
  const lowShrubs = group('shrubs', '庭院灌木与花池');
  const shrubMaterial = new THREE.MeshStandardMaterial({ name: 'courtyard-hedges', color: '#528834', roughness: 0.97 });
  for (const [x, z, w, d] of plan.landscape.shrubs) {
    if (x === undefined || z === undefined || w === undefined || d === undefined) continue;
    slab(lowShrubs, x, z, w, d, 0.4, 0.5, 0.8, shrubMaterial);
    for (let a = -w / 2 + 0.8; a < w / 2; a += 1.5) {
      const shrub = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), shrubMaterial);
      shrub.position.set(x + a, 1.08, z); shrub.scale.y = 0.8;
      lowShrubs.add(shrub);
    }
  }

  function facade(parent: THREE.Object3D, width: number, height: number, kind: string, floors: number, seed: number) {
    const rng = random(seed);
    const top = kind === 'fins' ? 3.4 : kind === 'pavilion' ? 0.65 : 2.6;
    const bottom = 0.45, openingHeight = height - top - bottom;
    const edge = kind === 'office' ? 4 : kind === 'fins' ? 2.8 : 0.85;
    const available = width - edge * 2;
    const bays = Math.max(2, Math.round(available / (kind === 'fins' ? 3.7 : 6)));
    const pitch = available / bays;
    const pier = kind === 'fins' ? 1.0 : kind === 'office' ? 1.4 : 0.48;
    for (let col = 0; col < bays; col++) {
      const cx = -available / 2 + (col + 0.5) * pitch;
      for (let floor = 0; floor < floors; floor++) {
        const paneH = openingHeight / floors;
        box(parent, [pitch - pier, paneH - 0.10, 0.16], [cx, bottom + (floor + 0.5) * paneH, 0.015], glass[Math.floor(rng() * glass.length)]!);
        box(parent, [pitch - pier, 0.10, 0.18], [cx, bottom + floor * paneH, 0.12], frame);
        box(parent, [0.065, paneH, 0.22], [cx, bottom + (floor + 0.5) * paneH, 0.13], frame);
      }
      box(parent, [pier, openingHeight, 0.52], [-available / 2 + col * pitch, bottom + openingHeight / 2, 0.12], white);
    }
    box(parent, [pier, openingHeight, 0.52], [available / 2, bottom + openingHeight / 2, 0.12], white);
    if (kind === 'fins') {
      box(parent, [width, 1.15, 0.62], [0, 9.0, 0.12], white);
    }
    if (kind === 'office') box(parent, [width, 0.75, 0.45], [0, 7.6, 0.12], white);
    for (let x = -width / 2 + 4; x < width / 2; x += 4) {
      box(parent, [0.028, top, 0.025], [x, height - top / 2, 0.16], seam);
    }
    box(parent, [width, 0.025, 0.025], [0, height - 0.75, 0.16], seam);
  }

  function faces(parent: THREE.Object3D, w: number, d: number, fn: (side: THREE.Group, width: number, index: number) => void) {
    const defs = [[0, d / 2, 0, w], [w / 2, 0, Math.PI / 2, d], [0, -d / 2, Math.PI, w], [-w / 2, 0, -Math.PI / 2, d]] as const;
    defs.forEach(([x, z, angle, width], index) => {
      const side = new THREE.Group(); side.position.set(x, 0, z); side.rotation.y = angle;
      parent.add(side); fn(side, width, index);
    });
  }

  function rooftop(parent: THREE.Object3D, width: number, depth: number, height: number, isTower: boolean) {
    box(parent, [width - 0.55, 0.3, depth - 0.55], [0, height - 0.12, 0], isTower ? roofDark : roof);
    box(parent, [width, 0.55, 0.3], [0, height + 0.12, depth / 2 - 0.15], white);
    box(parent, [width, 0.55, 0.3], [0, height + 0.12, -depth / 2 + 0.15], white);
    box(parent, [0.3, 0.55, depth - 0.6], [width / 2 - 0.15, height + 0.12, 0], white);
    box(parent, [0.3, 0.55, depth - 0.6], [-width / 2 + 0.15, height + 0.12, 0], white);
    for (const [x, z, scale] of [[-width * 0.29, -depth * 0.26, 1], [width * 0.28, depth * 0.19, 0.65]] as const) {
      box(parent, [3 * scale, 0.48 * scale, 2.2 * scale], [x, height + 0.24 * scale, z], roofEquipment);
      for (let j = 0; j < 5; j++) box(parent, [2.5 * scale, 0.025, 0.065], [x, height + 0.49 * scale, z + (j - 2) * 0.32 * scale], seam);
    }
    for (let x = -width / 2 + 6; x < width / 2; x += 7) box(parent, [0.025, 0.01, depth - 1], [x, height + 0.04, 0], seam);
  }

  function block(parent: THREE.Group, width: number, depth: number, height: number, kind: string, floors: number, seed: number) {
    box(parent, [width - 0.15, height, depth - 0.15], [0, height / 2, 0], white);
    faces(parent, width, depth, (side, span, index) => facade(side, span, height, kind, floors, seed + index * 7));
    rooftop(parent, width, depth, height, false);
  }

  const architecture = createArchitectureKit({ box, slab, faces, rooftop, facade,
    white, roof, seam, frame, darkFrame, grass, roofEquipment, glass });
  for (const [index, b] of plan.buildings.entries()) {
    const building = group(b.id, b.name);
    const courtyardBuilding = b.x > -30 && b.z > -20;
    building.position.set(b.x, courtyardBuilding ? 0.45 : 0.28, b.z);
    building.userData.home = building.position.toArray();
    building.userData.building = b;
    building.userData.features = b.features;
    if (courtyardBuilding) {
      slab(paving, b.x, b.z, b.width + 5, b.depth + 5, 0.396, 0.05, (b.radius ?? 1) + 2.5, sidewalk);
    }
    if (b.type === 'tower') {
      block(building, b.podiumWidth!, b.podiumDepth!, b.baseHeight!, 'curtain', 2, 17);
      const tower = new THREE.Group(); tower.position.set(-2, b.baseHeight!, -3); building.add(tower);
      box(tower, [b.width, b.height, b.depth], [0, b.height / 2, 0], white);
      faces(tower, b.width, b.depth, (side, span, face) => {
        const offset = face % 2 === 0 ? 1.6 : -0.8;
        const slot = span * (face % 2 === 0 ? 0.62 : 0.58);
        const y0 = 0.25, h = b.height - 4;
        for (let i = 0; i < 13; i++) {
          box(side, [slot, h / 13 - 0.11, 0.12], [offset, y0 + (i + 0.5) * h / 13, 0.075], glass[(i * 3 + face) % glass.length]!);
          box(side, [slot, 0.1, 0.17], [offset, y0 + i * h / 13, 0.17], frame);
        }
        for (const x of [offset - slot / 2, offset, offset + slot / 2]) box(side, [0.11, h, 0.3], [x, y0 + h / 2, 0.16], frame);
        for (const x of [offset - slot / 3, offset, offset + slot / 3]) box(side, [0.9, h, 0.46], [x, y0 + h / 2, 0.18], white);
        for (let x = -span / 2 + 4.2; x < span / 2; x += 4.2) {
          if (x > offset - slot / 2 - 0.2 && x < offset + slot / 2 + 0.2) continue;
          box(side, [0.025, b.height, 0.018], [x, b.height / 2, 0.011], seam);
        }
        for (let y = 4.7; y < b.height; y += 4.7) {
          for (const [a, c] of [[-span / 2, offset - slot / 2 - 0.15], [offset + slot / 2 + 0.15, span / 2]] as const) {
            box(side, [c - a, 0.025, 0.018], [(a + c) / 2, y, 0.011], seam);
          }
        }
      });
      rooftop(tower, b.width, b.depth, b.height, true);
    } else if (!architecture.build(building, b, index * 31 + 5)) {
      block(building, b.width, b.depth, b.height, b.type, b.floors!, index * 31 + 5);
      if (b.roofGarden) architecture.garden(building, b.width, b.depth, b.height, b.radius ?? 0, true);
    }
    batch(building);
  }

  const treePositions: Array<[number, number, number]> = [];
  const rng = random(724);
  function treeRow(x0: number, z0: number, x1: number, z1: number, spacing = 10, scale = 1) {
    const count = Math.floor(Math.hypot(x1 - x0, z1 - z0) / spacing);
    for (let i = 0; i <= count; i++) {
      const t = count ? i / count : 0;
      const x = THREE.MathUtils.lerp(x0, x1, t), z = THREE.MathUtils.lerp(z0, z1, t);
      const intersectsBuilding = plan.buildings.some((b) => {
        const width = b.podiumWidth ?? b.width, depth = b.podiumDepth ?? b.depth;
        return Math.abs(x - b.x) < width / 2 + 2.4 && Math.abs(z - b.z) < depth / 2 + 2.4;
      }) || (Math.abs(x + 105) < 13 && Math.abs(z - 58) < 24);
      if (!intersectsBuilding) treePositions.push([x, z, scale * (0.94 + rng() * 0.3)]);
    }
  }
  for (const [x0, z0, x1, z1, spacing, scale] of plan.landscape.treeRows) {
    if (x0 === undefined || z0 === undefined || x1 === undefined || z1 === undefined) continue;
    treeRow(x0, z0, x1, z1, spacing, scale);
  }
  for (const x of [-147, 147]) {
    slab(planting, x, 0, 5, 195, 0.04, 0.13, 2, grass);
    treeRow(x, -91, x, 92, 11, 0.85);
  }
  for (const z of [-126, 126]) {
    slab(planting, 0, z, 236, 5, 0.04, 0.13, 2, grass);
    treeRow(-112, z, 112, z, 13, 0.8);
  }

  const foliage = group('trees', '行道树');
  const clusterPieces: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 74; i++) {
    const t = rng(), angle = rng() * Math.PI * 2;
    const radius = Math.sqrt(rng()) * (0.45 + Math.sin(Math.PI * t) * 1.6);
    let cluster: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.27 + rng() * 0.25, flightDetail ? 0 : 1);
    cluster.deleteAttribute('normal'); cluster.deleteAttribute('uv');
    const welded = mergeVertices(cluster);
    cluster.dispose(); cluster = welded;
    const pos = cluster.getAttribute('position');
    for (let n = 0; n < pos.count; n++) {
      const jitter = 0.91 + rng() * 0.17;
      pos.setXYZ(n, pos.getX(n) * jitter, pos.getY(n) * jitter, pos.getZ(n) * jitter);
    }
    cluster.computeVertexNormals();
    cluster.translate(Math.cos(angle) * radius, 3.3 + t * 3.2, Math.sin(angle) * radius);
    clusterPieces.push(cluster);
  }
  const crownGeometry = mergeGeometries(clusterPieces)!;
  clusterPieces.forEach((geo) => geo.dispose());
  const leafMaterial = new THREE.MeshStandardMaterial({ name: 'foliage', color: '#c7dc9f', roughness: 1 });
  const barkMaterial = new THREE.MeshStandardMaterial({ name: 'bark', color: '#7d6b51', roughness: 1 });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11, 0.23, 3.5, 7), barkMaterial, treePositions.length);
  const crowns = new THREE.InstancedMesh(crownGeometry, leafMaterial, treePositions.length);
  const matrix = new THREE.Matrix4();
  treePositions.forEach(([x, z, scale], i) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28);
    matrix.compose(new THREE.Vector3(x, 0.39, z), q, new THREE.Vector3(scale, scale, scale));
    crowns.setMatrixAt(i, matrix);
    crowns.setColorAt(i, new THREE.Color().setHSL(0.24 + rng() * 0.045, 0.36 + rng() * 0.14, 0.38 + rng() * 0.12, THREE.SRGBColorSpace));
    matrix.compose(new THREE.Vector3(x, 0.39 + 1.75 * scale, z), q, new THREE.Vector3(scale, scale, scale));
    trunks.setMatrixAt(i, matrix);
  });
  crowns.name = 'trees:canopies'; trunks.name = 'trees:trunks';
  crowns.castShadow = trunks.castShadow = true;
  crowns.receiveShadow = true;
  foliage.add(trunks, crowns);
  const leafVertices: number[] = [];
  const leafNormals: number[] = [];
  const leafColors: number[] = [];
  const leafQuaternion = new THREE.Quaternion();
  const leafPoint = new THREE.Vector3();
  for (let i = 0; i < (flightDetail ? 180 : 2400); i++) {
    const y = rng();
    const theta = rng() * Math.PI * 2;
    const radius = Math.sqrt(rng()) * (0.3 + Math.sin(Math.PI * y) * 1.95);
    const center = new THREE.Vector3(Math.cos(theta) * radius, 3.1 + y * 3.9, Math.sin(theta) * radius);
    leafQuaternion.setFromEuler(new THREE.Euler(rng() * 6.28, rng() * 6.28, rng() * 6.28));
    const scale = 0.055 + rng() * 0.075;
    const leafColor = new THREE.Color().setHSL(0.25 + rng() * 0.05, 0.4, 0.35 + rng() * 0.2, THREE.SRGBColorSpace);
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(leafQuaternion);
    for (const point of [[0, 0, -1.6], [-0.7, 0, 0], [0, 0.25, 0], [0, 0.25, 0], [-0.7, 0, 0], [0, 0, 1.6], [0, 0, -1.6], [0, 0.25, 0], [0.7, 0, 0], [0, 0.25, 0], [0, 0, 1.6], [0.7, 0, 0]]) {
      leafPoint.fromArray(point).multiplyScalar(scale).applyQuaternion(leafQuaternion).add(center);
      leafVertices.push(...leafPoint.toArray()); leafNormals.push(...normal.toArray()); leafColors.push(...leafColor.toArray());
    }
  }
  const leavesGeometry = new THREE.BufferGeometry();
  leavesGeometry.setAttribute('position', new THREE.Float32BufferAttribute(leafVertices, 3));
  leavesGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(leafNormals, 3));
  leavesGeometry.setAttribute('color', new THREE.Float32BufferAttribute(leafColors, 3));
  const leaves = new THREE.InstancedMesh(leavesGeometry, new THREE.MeshStandardMaterial({ name: 'individual-leaves', vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 }), treePositions.length);
  treePositions.forEach((_, i) => { crowns.getMatrixAt(i, matrix); leaves.setMatrixAt(i, matrix); });
  leaves.name = 'trees:leaves'; leaves.castShadow = false; leaves.receiveShadow = true;
  foliage.add(leaves);
  foliage.userData.treeCount = treePositions.length;

  const context = group('context', '周边建筑');
  let contextIndex = 0;
  for (const z of [-177, -333, -495]) for (const x of [-370, -217, -66, 47, 211, 371]) {
    const width = 36 + rng() * 22, depth = 23 + rng() * 13, h = 9 + rng() * 9;
    const blockGroup = new THREE.Group(); blockGroup.position.set(x, 0.18, z + rng() * 12);
    context.add(blockGroup);
    slab(planting, x, blockGroup.position.z, width + 12, depth + 10, 0.04, 0.1, 3, grass);
    slab(paving, x, blockGroup.position.z, width + 7, depth + 6, 0.15, 0.1, 2, sidewalk);
    box(blockGroup, [width, h, depth], [0, h / 2, 0], white);
    faces(blockGroup, width, depth, (side, span) => {
      for (let floor = 0; floor < 3; floor++) {
        box(side, [span * 0.81, h / 4.8, 0.1], [0, 1.7 + floor * h / 3.4, 0.06], glass[6]!);
        for (let px = -span * 0.4; px < span * 0.4; px += 4) box(side, [0.12, h / 4.8, 0.14], [px, 1.7 + floor * h / 3.4, 0.12], white);
      }
    });
    rooftop(blockGroup, width, depth, h, false); contextIndex++;
  }
  batch(context);
  batch(roads); batch(planting); batch(paving); batch(lawn); batch(lowShrubs);
  // Large planar batches need world-scaled UVs to retain paving and asphalt grain.
  for (const owner of [roads, planting, paving, lawn]) owner.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const p = node.geometry.getAttribute('position'), uv = node.geometry.getAttribute('uv');
    const step = node.material === sidewalk ? 8 : 10;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / step, p.getZ(i) / step);
  });
  root.userData.sculptRuntime = { nodes: parts, sockets: {}, colliders: Object.fromEntries(plan.buildings.map((b) => [b.id, { type: 'box', footprint: [b.width, b.depth], height: b.height }])), destructionGroups: {} };
  root.userData.spec = plan;
  root.userData.contextBuildings = contextIndex;
  return { root, parts, buildingIds: plan.buildings.map((b) => b.id) };
}
