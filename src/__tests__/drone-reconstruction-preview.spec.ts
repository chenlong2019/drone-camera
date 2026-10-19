import { describe, expect, it } from 'vitest'
import { ReconstructionPreview } from '../lib/drone-camera/drone-reconstruction-preview'

interface FakePrimitive {
  show: boolean
  destroyed?: boolean
  destroy(): void
}

function primitive(show = true): FakePrimitive {
  return {
    show,
    destroy() { this.destroyed = true },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function createPreview(loader: (url: string) => Promise<FakePrimitive>, original?: FakePrimitive | FakePrimitive[]) {
  const mounted: FakePrimitive[] = []
  const primitives = {
    add(value: FakePrimitive) { mounted.push(value); return value },
    remove(value: FakePrimitive) {
      const index = mounted.indexOf(value)
      if (index >= 0) mounted.splice(index, 1)
      return index >= 0
    },
  }
  const preview = new ReconstructionPreview({ viewer: { scene: { primitives } }, loader, original })
  return { preview, mounted, primitives }
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
    expect(original.show).toBe(true)
  })

  it('keeps the latest request when loads resolve in reverse order', async () => {
    const first = deferred<FakePrimitive>()
    const second = deferred<FakePrimitive>()
    const { preview, mounted } = createPreview((url) => url === '/first' ? first.promise : second.promise)
    const stale = primitive()
    const latest = primitive()
    const firstLoad = preview.load('/first')
    const firstRejected = expect(firstLoad).rejects.toThrow('superseded')
    const secondLoad = preview.load('/second')

    second.resolve(latest)
    await secondLoad
    first.resolve(stale)
    await firstRejected

    expect(preview.tileset).toBe(latest)
    expect(preview.url).toBe('/second')
    expect(mounted).toEqual([latest])
    expect(stale.destroyed).toBe(true)
    expect(latest.destroyed).toBeUndefined()
    preview.destroy()
  })

  it('releases a tileset that finishes loading after the preview is destroyed', async () => {
    const pending = deferred<FakePrimitive>()
    const original = primitive()
    const { preview, mounted } = createPreview(() => pending.promise, original)
    preview.setCompareMode('reconstructed')
    const load = preview.load('/pending')
    const rejected = expect(load).rejects.toThrow('destroyed')
    preview.destroy()
    const late = primitive()
    pending.resolve(late)
    await rejected

    expect(late.destroyed).toBe(true)
    expect(mounted).toEqual([])
    expect(preview.tileset).toBeNull()
    expect(original.show).toBe(true)
    expect(() => preview.setVisible(true)).toThrow('destroyed')
    expect(() => preview.setCompareMode('original')).toThrow('destroyed')
    expect(() => preview.setOriginal(original)).toThrow('destroyed')
    preview.destroy()
  })

  it('restores each original visibility when replacing originals and destroying', () => {
    const visible = primitive(true)
    const hidden = primitive(false)
    const replacement = primitive(true)
    const { preview } = createPreview(async () => primitive(), [visible, hidden])
    preview.setCompareMode('reconstructed')
    expect(visible.show).toBe(false)
    expect(hidden.show).toBe(false)

    preview.setOriginal(replacement)
    expect(visible.show).toBe(true)
    expect(hidden.show).toBe(false)
    expect(replacement.show).toBe(false)
    preview.destroy()
    expect(replacement.show).toBe(true)
    expect(visible.destroyed).toBeUndefined()
    expect(hidden.destroyed).toBeUndefined()
    expect(replacement.destroyed).toBeUndefined()
  })

  it('preserves the mounted result after a loader or mount failure', async () => {
    const current = primitive()
    const rejected = primitive()
    const { preview, mounted, primitives } = createPreview(async (url) => {
      if (url === '/network-error') throw new Error('Network failed')
      return url === '/current' ? current : rejected
    })
    await preview.load('/current')
    await expect(preview.load('/network-error')).rejects.toThrow('Network failed')
    primitives.add = () => { throw new Error('Mount failed') }
    await expect(preview.load('/mount-error')).rejects.toThrow('Mount failed')

    expect(preview.tileset).toBe(current)
    expect(preview.url).toBe('/current')
    expect(mounted).toEqual([current])
    expect(current.destroyed).toBeUndefined()
    expect(rejected.destroyed).toBe(true)
    preview.destroy()
  })

  it('does not remount or destroy a loader result that is already mounted', async () => {
    const tileset = primitive()
    const { preview, mounted } = createPreview(async () => tileset)
    await preview.load('/same')
    await preview.load('/same')
    expect(mounted).toEqual([tileset])
    expect(tileset.destroyed).toBeUndefined()
    preview.destroy()
  })
})
