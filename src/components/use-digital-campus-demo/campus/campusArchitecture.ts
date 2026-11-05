// Ported from img2threejs/preview park-v3 scene source.
import * as THREE from 'three';

type V3 = [number, number, number];
export type CampusBuilding = {
  id: string; type: string; width: number; depth: number; height: number;
  floors?: number; radius?: number; roofGarden?: boolean; roofRoomHeight?: number;
};
type ArchitectureTools = {
  box: (parent: THREE.Object3D, size: V3, position: V3, material: THREE.Material) => THREE.Mesh;
  slab: (parent: THREE.Object3D, x: number, z: number, width: number, depth: number, y: number, height: number, radius: number, material: THREE.Material) => THREE.Mesh;
  faces: (parent: THREE.Object3D, width: number, depth: number, fn: (side: THREE.Group, span: number, index: number) => void) => void;
  rooftop: (parent: THREE.Object3D, width: number, depth: number, height: number, isTower: boolean) => void;
  facade: (parent: THREE.Object3D, width: number, height: number, kind: string, floors: number, seed: number) => void;
  white: THREE.Material; roof: THREE.Material; seam: THREE.Material; frame: THREE.Material;
  darkFrame: THREE.Material; grass: THREE.Material; roofEquipment: THREE.Material;
  glass: THREE.MeshPhysicalMaterial[];
};

// Sample the real footprint perimeter; every glazing panel and band follows this same curve.
function perimeter(width: number, depth: number, radius: number, pitch = 2.2) {
  const r = Math.min(radius, width / 2, depth / 2);
  const corners: V3[] = [[width / 2 - r, depth / 2 - r, 0], [-width / 2 + r, depth / 2 - r, Math.PI / 2],
    [-width / 2 + r, -depth / 2 + r, Math.PI], [width / 2 - r, -depth / 2 + r, Math.PI * 1.5]];
  const vertices: THREE.Vector2[] = [];
  for (const [x, z, start] of corners) {
    const segments = Math.max(4, Math.ceil(Math.PI * r / (2 * pitch)));
    for (let i = 0; i <= segments; i++) {
      const angle = start + i * Math.PI / (2 * segments);
      vertices.push(new THREE.Vector2(x + r * Math.cos(angle), z + r * Math.sin(angle)));
    }
  }
  const points: THREE.Vector2[] = [];
  vertices.forEach((a, i) => {
    const b = vertices[(i + 1) % vertices.length]!;
    const distance = a.distanceTo(b);
    if (distance < 0.001) return;
    const n = Math.max(1, Math.ceil(distance / pitch));
    for (let j = 0; j < n; j++) points.push(a.clone().lerp(b, j / n));
  });
  return points;
}

export function createArchitectureKit(t: ArchitectureTools) {
  const metal = new THREE.MeshStandardMaterial({ name: 'horizontal-louver-metal', color: '#879fb4', metalness: 0.52, roughness: 0.32 });
  const hedge = new THREE.MeshStandardMaterial({ name: 'roof-hedges', color: '#4f8d36', roughness: 0.95 });
  const hedgeLight = new THREE.MeshStandardMaterial({ name: 'roof-shrubs', color: '#76a54a', roughness: 0.94 });
  const interior = new THREE.MeshStandardMaterial({ name: 'atrium-interior', color: '#d2d9db', roughness: 0.7 });
  const clearGlass = new THREE.MeshPhysicalMaterial({ name: 'atrium-clear-glass', color: '#79a7bb', roughness: 0.08,
    metalness: 0.02, clearcoat: 1, transparent: true, opacity: 0.62, depthWrite: false, transmission: 0, thickness: 0.12 });
  const railingGlass = new THREE.MeshPhysicalMaterial({ name: 'terrace-balustrade-glass', color: '#bddce3', roughness: 0.13,
    transparent: true, opacity: 0.42, depthWrite: false, metalness: 0.05 });
  const shrubGeometry = new THREE.IcosahedronGeometry(1, 1);

  function shrub(parent: THREE.Object3D, x: number, y: number, z: number, size = 0.7) {
    const mesh = new THREE.Mesh(shrubGeometry, (Math.round(x + z) % 2) ? hedge : hedgeLight);
    mesh.position.set(x, y + size * 0.5, z); mesh.scale.set(size, size * 0.65, size * 0.8);
    mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh);
  }
  function planter(parent: THREE.Object3D, x: number, y: number, z: number, width: number, depth: number) {
    t.box(parent, [width, 0.45, depth], [x, y + 0.225, z], t.white);
    t.box(parent, [width - 0.25, 0.16, depth - 0.25], [x, y + 0.5, z], hedge);
    const alongX = width > depth, length = Math.max(width, depth);
    for (let a = -length / 2 + 0.8; a < length / 2 - 0.3; a += 1.4) {
      shrub(parent, x + (alongX ? a : 0), y + 0.58, z + (alongX ? 0 : a), 0.7);
    }
  }
  function edge(parent: THREE.Object3D, a: THREE.Vector2, b: THREE.Vector2, y: number, height: number, thick: number, material: THREE.Material) {
    const length = a.distanceTo(b);
    const mesh = t.box(parent, [length + 0.025, height, thick], [(a.x + b.x) / 2, y + height / 2, (a.y + b.y) / 2], material);
    mesh.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
    return mesh;
  }
  function rim(parent: THREE.Object3D, width: number, depth: number, radius: number, y: number, height: number, thick: number, material: THREE.Material) {
    const points = perimeter(width, depth, radius, 1.2);
    points.forEach((a, i) => edge(parent, a, points[(i + 1) % points.length]!, y, height, thick, material));
  }
  function garden(parent: THREE.Group, width: number, depth: number, height: number, radius = 0, room = true) {
    const w = width - 3.5, d = depth - 3.5;
    t.slab(parent, 0, 0, w, d, height + 0.18, 0.12, Math.max(0, radius - 1.8), t.grass);
    t.slab(parent, 0, 0, w - 5.4, d - 5.4, height + 0.31, 0.08, Math.max(0, radius - 4.5), t.roof);
    rim(parent, width - 0.65, depth - 0.65, Math.max(0.1, radius - 0.3), height + 0.35, 1.1, 0.11, railingGlass);
    rim(parent, width - 0.65, depth - 0.65, Math.max(0.1, radius - 0.3), height + 1.45, 0.055, 0.12, t.frame);
    const samples = perimeter(w - 1, d - 1, Math.max(0.1, radius - 2.4), 2.2);
    samples.forEach((p, i) => { if (i % 2 === 0) shrub(parent, p.x, height + 0.32, p.y, 0.75); });
    if (room) {
      const rw = Math.min(14, w * 0.46), rd = Math.min(9, d * 0.36);
      t.box(parent, [rw, 2.7, rd], [0, height + 1.7, -d * 0.08], t.white);
      t.box(parent, [rw * 0.84, 2.0, 0.14], [0, height + 1.55, -d * 0.08 + rd / 2 + 0.08], t.glass[5]!);
      t.box(parent, [rw + 0.6, 0.25, rd + 0.6], [0, height + 3.15, -d * 0.08], t.roof);
    } else {
      for (const s of [-1, 1]) {
        t.box(parent, [Math.min(7, w * 0.42), 0.5, Math.min(5.5, d * 0.2)], [0, height + 0.65, s * d * 0.27], t.frame);
        t.box(parent, [Math.min(6.6, w * 0.4), 0.08, Math.min(5.1, d * 0.18)], [0, height + 0.96, s * d * 0.27], t.glass[8]!);
      }
    }
  }

  function curvedFacade(parent: THREE.Group, width: number, depth: number, height: number, radius: number, floors: number,
    options: { solid?: boolean; bands?: number; transparent?: boolean; roof?: boolean } = {}) {
    const points = perimeter(width, depth, radius);
    if (options.solid !== false) t.slab(parent, 0, 0, width - 0.35, depth - 0.35, 0, height, Math.max(0.1, radius - 0.17), t.darkFrame);
    const floorHeight = height / floors, band = options.bands ?? 0.28;
    points.forEach((a, i) => {
      const b = points[(i + 1) % points.length]!;
      for (let f = 0; f < floors; f++) {
        const pane = edge(parent, a, b, f * floorHeight + band, floorHeight - band - 0.07, 0.12,
          options.transparent ? clearGlass : t.glass[(i * 3 + f * 2) % t.glass.length]!);
        pane.castShadow = !options.transparent;
        edge(parent, a, b, f * floorHeight + floorHeight * 0.58, 0.065, 0.18, t.frame);
      }
      const mullion = t.box(parent, [0.1, height, 0.1], [a.x, height / 2, a.y], t.frame);
      mullion.castShadow = false;
    });
    for (let f = 0; f < floors; f++) {
      rim(parent, width + 0.2, depth + 0.2, radius + 0.1, f * floorHeight, band, 0.28, band > 0.6 ? t.white : t.frame);
    }
    if (options.roof !== false) {
      t.slab(parent, 0, 0, width + 0.5, depth + 0.5, height, 0.35, radius + 0.25, t.roof);
      rim(parent, width + 0.4, depth + 0.4, radius + 0.2, height, 1.3, 0.27, t.white);
    }
  }

  function flatFacade(parent: THREE.Group, span: number, height: number, floors: number, kind: string, seed: number) {
    const margin = kind === 'glass-tower' ? 0.25 : 1.7;
    const available = span - margin * 2;
    const columns = Math.max(3, Math.round(available / (kind === 'grid' ? 3.0 : 2.5)));
    const dx = available / columns, dy = (height - 2.4) / floors;
    for (let col = 0; col < columns; col++) for (let row = 0; row < floors; row++) {
      const width = kind === 'grid' ? dx * 0.48 : dx - 0.09;
      const h = kind === 'grid' ? dy * 0.65 : kind === 'banded' ? dy * 0.66 : dy - 0.08;
      const x = -available / 2 + (col + 0.5) * dx, y = 0.8 + (row + 0.5) * dy;
      t.box(parent, [width, h, 0.14], [x, y, 0.09], t.glass[(col * 2 + row + seed) % t.glass.length]!);
      if (kind !== 'grid') {
        t.box(parent, [0.065, h, 0.19], [x - width / 2, y, 0.17], t.frame);
        t.box(parent, [width, 0.07, 0.19], [x, y - h / 2, 0.17], t.frame);
      }
    }
    if (kind === 'banded') for (let row = 1; row < floors; row++) {
      t.box(parent, [span + 0.15, 0.5, 0.4], [0, 0.8 + row * dy, 0.14], t.white);
    }
  }

  function rectangular(parent: THREE.Group, b: CampusBuilding, kind: string, seed: number) {
    const baseMaterial = kind === 'glass-tower' ? t.darkFrame : t.white;
    t.box(parent, [b.width - 0.18, b.height, b.depth - 0.18], [0, b.height / 2, 0], baseMaterial);
    t.faces(parent, b.width, b.depth, (side, span, face) => flatFacade(side, span, b.height, b.floors ?? 6, kind, seed + face));
    t.rooftop(parent, b.width, b.depth, b.height, false);
    t.box(parent, [b.width * 0.45, 2.2, b.depth * 0.33], [0, b.height + 1.2, -2], t.white);
    t.box(parent, [b.width * 0.38, 0.08, b.depth * 0.25], [0, b.height + 2.35, -2], t.glass[7]!);
  }

  function louvers(parent: THREE.Group, span: number, height: number) {
    const width = span - 8.5, lower = 4.3, upper = height - 3.0;
    t.box(parent, [width, upper - lower, 0.18], [0, (lower + upper) / 2, 0.14], t.glass[0]!);
    for (let y = lower; y < upper; y += 0.48) {
      const slat = t.box(parent, [width + 0.55, 0.15, 0.78], [0, y, 0.51], metal);
      slat.rotation.x = -0.13;
    }
    t.box(parent, [width + 0.85, 0.23, 0.86], [0, upper + 0.12, 0.5], t.white);
    for (const x of [-width / 2 - 0.3, width / 2 + 0.3]) t.box(parent, [0.23, upper - lower + 0.25, 0.86], [x, (lower + upper) / 2, 0.5], t.white);
    for (let x = -span / 2 + 1.5; x < span / 2 - 1; x += 3.1) {
      t.box(parent, [2.9, 3.45, 0.16], [x, 1.9, 0.09], t.glass[4]!);
      t.box(parent, [0.1, 3.45, 0.25], [x - 1.45, 1.9, 0.16], t.frame);
    }
  }

  function build(parent: THREE.Group, b: CampusBuilding, seed: number): boolean {
    const { width: w, depth: d, height: h } = b;
    if (b.type === 'rounded-tower') {
      const wing = new THREE.Group(); wing.position.set(-20, 0, -7); parent.add(wing);
      rectangular(wing, { id: 'wing', type: 'banded', width: 21, depth: 44, height: 25, floors: 6 }, 'banded', seed);
      garden(wing, 21, 44, 25, 0, false);
      curvedFacade(parent, w, d, h, b.radius!, b.floors!, { bands: 0.72 });
      garden(parent, w, d, h, b.radius, true);
      return true;
    }
    if (b.type === 'drum' || b.type === 'forum') {
      curvedFacade(parent, w, d, h, b.radius!, b.floors!, { bands: b.type === 'forum' ? 1.55 : 0.22 });
      if (b.roofGarden) garden(parent, w, d, h, b.radius, true);
      else t.slab(parent, 0, 0, w - 0.5, d - 0.5, h + 0.35, 0.8, b.radius! - 0.25, t.roof);
      return true;
    }
    if (['grid', 'banded', 'glass-tower'].includes(b.type)) {
      rectangular(parent, b, b.type, seed); return true;
    }
    if (b.type === 'garden-office') {
      curvedFacade(parent, w, d, h, b.radius!, b.floors!, { bands: 0.22 });
      const side = new THREE.Group(); side.position.x = w / 2 + 0.1; side.rotation.y = Math.PI / 2;
      parent.add(side); t.facade(side, d - b.radius! * 2, h, 'fins', b.floors!, seed);
      garden(parent, w, d, h, b.radius, false);
      const podium = new THREE.Group(); podium.position.set(17, 0, -10); parent.add(podium);
      rectangular(podium, { id: 'podium', type: 'banded', width: 9, depth: 22, height: 7, floors: 1 }, 'banded', seed);
      planter(podium, 0, 7.3, 0, 4, 16);
      return true;
    }
    if (b.type === 'rounded-louver') {
      const r = b.radius!;
      curvedFacade(parent, w, d, h, r, 5, { bands: 0.15 });
      for (let y = 4; y < h - 2.4; y += 0.5) rim(parent, w + 0.4, d + 0.4, r + 0.2, y, 0.16, 0.6, metal);
      t.slab(parent, 0, 0, w + 0.8, d + 0.8, h - 2.2, 2.5, r + 0.4, t.white);
      return true;
    }
    if (b.type === 'louver-hall') {
      t.slab(parent, 0, 0, w - 0.1, d - 0.1, 0, h, b.radius!, t.white);
      t.faces(parent, w, d, (side, span) => {
        if (span >= Math.max(w, d) - 1) louvers(side, span - b.radius! * 0.6, h);
        else t.facade(side, span - 2.4, h, 'fins', b.floors!, seed);
      });
      t.rooftop(parent, w, d, h, false);
      if (b.roofGarden) garden(parent, w, d, h, 1, false);
      else {
        t.box(parent, [18, 3.6, 10], [-w * 0.26, h + 1.8, -2.5], t.white);
        planter(parent, w * 0.18, h + 0.2, -d * 0.34, w * 0.32, 2.2);
        const link = new THREE.Group(); link.position.set(w / 2 + 6, 0, 1); parent.add(link);
        rectangular(link, { id: 'entry-link', type: 'banded', width: 12, depth: 12, height: 7, floors: 1 }, 'banded', seed);
      }
      return true;
    }
    if (b.type === 'terraced-block') {
      rectangular(parent, b, 'banded', seed);
      const roomHeight = b.roofRoomHeight ?? 6;
      t.box(parent, [w * 0.79, roomHeight, d * 0.55], [1, h + roomHeight / 2, -d * 0.1], t.white);
      t.box(parent, [w * 0.7, 2.2, 0.16], [1, h + 1.7, d * 0.175 + 0.1], t.glass[6]!);
      planter(parent, 0, h + 0.25, d * 0.38, w * 0.8, 2.1);
      planter(parent, -w * 0.43, h + 0.25, 0, 2.2, d * 0.7);
      rim(parent, w - 1, d - 1, 0.2, h + 0.35, 0.8, 0.2, t.white);
      return true;
    }
    if (b.type === 'atrium') {
      const r = b.radius!;
      for (let floor = 0; floor < b.floors!; floor++) {
        const y = floor * h / b.floors!;
        t.slab(parent, 0, 0, w - 0.8, d - 0.8, y, 0.28, r - 0.4, interior);
        for (const x of [-w / 2 + 3, w / 2 - 3]) for (const z of [-d / 2 + 3, d / 2 - 3]) {
          t.box(parent, [0.3, h / b.floors!, 0.3], [x, y + h / (2 * b.floors!), z], t.frame);
        }
      }
      for (let step = 0; step < 16; step++) t.box(parent, [3.2, 0.25, 0.5], [-4, 0.3 + step * 0.34, -6 + step * 0.5], t.roof);
      curvedFacade(parent, w, d, h, r, b.floors!, { solid: false, transparent: true, roof: false });
      t.slab(parent, 0, 0, w, d, h, 0.1, r, clearGlass);
      rim(parent, w + 0.2, d + 0.2, r + 0.1, h, 0.38, 0.28, t.white);
      for (let x = -w / 2 + r; x <= w / 2 - r; x += 2.6) t.box(parent, [0.10, 0.13, d], [x, h + 0.15, 0], t.frame);
      for (let z = -d / 2 + r; z <= d / 2 - r; z += 2.6) t.box(parent, [w, 0.13, 0.1], [0, h + 0.15, z], t.frame);
      for (const x of [-2.1, 0, 2.1]) t.box(parent, [0.13, 3.2, 0.3], [x, 1.6, d / 2 + 0.18], t.frame);
      t.box(parent, [4.8, 0.18, 1.2], [0, 3.3, d / 2 + 0.25], t.frame);
      return true;
    }
    return false;
  }
  return { build, garden };
}
