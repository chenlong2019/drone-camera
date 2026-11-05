import { describe, expect, it, vi } from 'vitest'
import { DroneSim } from '@/lib/drone-camera/drone-sim'
import { CRC_EXTRA, MESSAGE_DEFS, wireOrder } from '@/lib/drone-camera/drone-mavlink-defs'

/**
 * 外部接管下的摇杆通道。
 *
 * 这条链路踩过一次坑:`DroneSim.setStick` 只写了自己的 `stick` 字段,
 * 而外部接管时 `step()` 早退、根本不积分 —— 面板上的杆子图形会动,飞机却一动不动。
 * 所以「接管后摇杆必须转发给外部源」是硬约束,用测试钉住。
 */
describe('外部接管下的摇杆转发', () => {
  it('接管后 setStick 会把完整行程交给外部源的 stick()', () => {
    const sim = new DroneSim()
    const stick = vi.fn()
    sim.attachExternalSource({ read: () => null, online: () => true, stick })

    sim.setStick({ pitch: 0.5 })

    expect(stick).toHaveBeenCalledTimes(1)
    // 传的是合并后的完整行程,不是那一帧的增量
    expect(stick.mock.calls[0]![0]).toEqual({ throttle: 0, yaw: 0, pitch: 0.5, roll: 0 })
  })

  it('多次 setStick 每次都转发(外部源自己负责节流)', () => {
    const sim = new DroneSim()
    const stick = vi.fn()
    sim.attachExternalSource({ read: () => null, online: () => true, stick })

    sim.setStick({ pitch: 1 })
    sim.setStick({ roll: -1 })

    expect(stick).toHaveBeenCalledTimes(2)
    expect(stick.mock.calls[1]![0]).toMatchObject({ pitch: 1, roll: -1 })
  })

  it('外部源没有 stick 能力时(只读回放源)不报错', () => {
    const sim = new DroneSim()
    sim.attachExternalSource({ read: () => null, online: () => true })
    expect(() => sim.setStick({ throttle: 1 })).not.toThrow()
    // 内置模型路径照旧:行程落在自己的状态上
    expect(sim.stick.throttle).toBe(1)
  })
})

/**
 * MANUAL_CONTROL 的定义陷阱:
 * - 首字段叫 `target`,不是其它消息惯用的 `target_system` —— 名字参与 CRC_EXTRA 哈希,
 *   抄错一个字飞控就会静默丢帧(表现为"打杆没反应"且没有任何报错);
 * - z 轴是 0~1000、500 居中(PX4 内部做 `(z/1000)*2-1`),不是 ±1000。
 */
describe('MANUAL_CONTROL 消息定义', () => {
  it('CRC_EXTRA 与硬编码表一致(243)', () => {
    const def = MESSAGE_DEFS.MANUAL_CONTROL
    let crc = 0xffff
    const accumulate = (bytes: number[]) => {
      for (const byte of bytes) {
        let tmp = byte ^ (crc & 0xff)
        tmp = (tmp ^ (tmp << 4)) & 0xff
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
      }
    }
    const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0))
    accumulate(ascii('MANUAL_CONTROL '))
    for (const field of wireOrder(def)) {
      if (field.ext) continue
      accumulate(ascii(`${field.type} `))
      accumulate(ascii(`${field.name} `))
    }
    expect(((crc & 0xff) ^ (crc >> 8)) & 0xff).toBe(CRC_EXTRA.MANUAL_CONTROL)
    expect(CRC_EXTRA.MANUAL_CONTROL).toBe(243)
  })

  it('wire 顺序按宽度降序:x/y/z/r 在前,目标在最后', () => {
    const order = wireOrder(MESSAGE_DEFS.MANUAL_CONTROL).filter((field) => !field.ext)
    expect(order.map((field) => field.name)).toEqual(['x', 'y', 'z', 'r', 'buttons', 'target'])
  })
})
