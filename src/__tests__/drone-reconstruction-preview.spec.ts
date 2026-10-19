import { describe, expect, it } from 'vitest'
import { ReconstructionPreview } from '../lib/drone-camera/drone-reconstruction-preview'

interface FakePrimitive {
  show: boolean
  destroyed?: boolean
  destroy(): void
}

describe('ReconstructionPreview', () => {
  it('loads an injected tileset and toggles comparison layers without DOM or Cesium', async () => {
    const original: FakePrimitive = {
      show: true,
      destroy() {
        this.destroyed = true
      },
    }
    const mounted: FakePrimitive[] = []
    const primitives = {
      add(primitive: FakePrimitive): FakePrimitive {
        mounted.push(primitive)
        return primitive
      },
      remove(primitive: FakePrimitive): boolean {
        const index = mounted.indexOf(primitive)
        if (index >= 0) mounted.splice(index, 1)
        return index >= 0
      },
    }
    const viewer = { scene: { primitives } }
    const preview = new ReconstructionPreview<FakePrimitive, FakePrimitive>({
      viewer,
      original,
      loader: { fromUrl: async () => ({ show: false, destroy() {} }) },
    })

    const tileset = await preview.load('/outputs/building/tileset.json')
    expect(preview.tileset).toBe(tileset)
    expect(mounted).toEqual([tileset])
    expect(original.show).toBe(true)
    expect(tileset.show).toBe(true)

    preview.setCompareMode('original')
    expect(original.show).toBe(true)
    expect(tileset.show).toBe(false)

    preview.setCompareMode('reconstructed')
    expect(original.show).toBe(false)
    expect(tileset.show).toBe(true)

    preview.setVisible(false)
    expect(original.show).toBe(false)
    expect(tileset.show).toBe(false)

    preview.destroy()
    expect(mounted).toEqual([])
    expect(preview.tileset).toBeNull()
    expect(original.destroyed).toBeUndefined()
  })
})
