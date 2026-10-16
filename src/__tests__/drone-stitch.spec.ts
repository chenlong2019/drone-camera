import { describe, expect, it } from 'vitest'
import { angularExtent } from '../lib/drone-camera/drone-stitch'

describe('panorama shot coverage bounds', () => {
  it('contains the full vertical field around an elevated camera center', () => {
    const centerPhi = 60
    const pitch = (centerPhi * Math.PI) / 180
    const tanH = Math.tan((60 * Math.PI) / 360)
    const tanV = Math.tan((36 * Math.PI) / 360)
    const right: [number, number, number] = [1, 0, 0]
    const up: [number, number, number] = [0, Math.cos(pitch), Math.sin(pitch)]
    const forward: [number, number, number] = [0, Math.sin(pitch), -Math.cos(pitch)]
    const extent = angularExtent(0, centerPhi, right, up, forward, tanH, tanV)
    const cornerPhis = [-1, 1].flatMap((x) =>
      [-1, 1].map((y) => {
        const dx = x * tanH
        const dy = forward[1] + y * tanV * up[1]
        const dz = forward[2] + y * tanV * up[2]
        return (Math.asin(dy / Math.hypot(dx, dy, dz)) * 180) / Math.PI
      }),
    )

    expect(extent.halfPhi).toBeGreaterThan(20)
    expect(cornerPhis.every((phi) => Math.abs(phi - centerPhi) <= extent.halfPhi)).toBe(true)
  })
})
