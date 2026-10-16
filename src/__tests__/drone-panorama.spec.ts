import { describe, expect, it } from 'vitest'
import {
  PANORAMA_PRESETS,
  PanoramaCapture,
  sphericalPitchGrid,
} from '../lib/drone-camera/drone-panorama'

describe('panorama capture presets', () => {
  it('offers a nine-shot wide-angle grid', () => {
    const preset = PANORAMA_PRESETS['pano-wide']

    expect(preset.total).toBe(9)
    expect(new Set(preset.shots.map((shot) => shot.bodyYaw))).toEqual(new Set([-30, 0, 30]))
    expect(new Set(preset.shots.map((shot) => shot.pitch))).toEqual(new Set([20, 0, -20]))
  })

  it('keeps the 180-degree panorama grid at 21 shots', () => {
    const preset = PANORAMA_PRESETS['pano-180']

    expect(preset.total).toBe(21)
    expect(preset.shots).toHaveLength(21)
    expect(preset.shots.every((shot) => shot.pitch !== 90 && shot.pitch !== -90)).toBe(true)
  })

  it('spaces spherical panorama rings according to vertical FOV', () => {
    const verticalFovDeg = 24
    const maxStep = verticalFovDeg * 0.6
    const pitches = sphericalPitchGrid(verticalFovDeg)
    const lastPitch = pitches[pitches.length - 1]!
    const steps = [
      90 - pitches[0]!,
      ...pitches.slice(1).map((pitch, index) => pitches[index]! - pitch),
      lastPitch + 90,
    ]

    expect(pitches[0]).toBeLessThan(90)
    expect(lastPitch).toBeGreaterThan(-90)
    expect(steps.every((step) => step <= maxStep)).toBe(true)
    expect(pitches.every((pitch, index) => index === 0 || pitches[index - 1]! > pitch)).toBe(true)
  })

  it('covers a full spherical panorama with FOV-dependent overlapping rings and both poles', () => {
    const verticalFovDeg = 24
    const preset = PanoramaCapture.preset('pano-360', verticalFovDeg)
    const zenith = preset.shots.find((shot) => shot.pitch === 90)
    const nadir = preset.shots.find((shot) => shot.pitch === -90)
    const ringShots = preset.shots.filter((shot) => shot.pitch !== 90 && shot.pitch !== -90)
    const ringPitches = [...new Set(ringShots.map((shot) => shot.pitch))]
    const expectedRows = sphericalPitchGrid(verticalFovDeg).length

    expect(preset.total).toBe(8 * expectedRows + 2)
    expect(ringShots).toHaveLength(8 * expectedRows)
    expect(new Set(ringShots.map((shot) => shot.bodyYaw)).size).toBe(8)
    expect(ringPitches).toEqual(sphericalPitchGrid(verticalFovDeg))
    expect(zenith?.bodyYaw).toBe(0)
    expect(nadir?.bodyYaw).toBe(0)
    expect(preset.shots.map((shot) => shot.index)).toEqual(
      Array.from({ length: preset.total }, (_, index) => index + 1),
    )
    expect(preset.shots[preset.shots.length - 1]?.pitch).toBe(-90)
  })

  it('uses the conservative fallback FOV when no camera intrinsics are available', () => {
    expect(PANORAMA_PRESETS['pano-360'].total).toBe(
      8 * sphericalPitchGrid(24).length + 2,
    )
    expect(PanoramaCapture.preset('pano-360').total).toBe(PANORAMA_PRESETS['pano-360'].total)
  })
})
