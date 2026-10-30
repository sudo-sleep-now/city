/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { createCityCenter } from '../src/lib/city/city-center'
import type { CityMaterials } from '../src/lib/city/types'

const material = new THREE.MeshStandardMaterial({ color: '#b9ad95' })
const mats = new Proxy({ signMaterial: () => material }, {
  get: (target, key) => key === 'signMaterial' ? target.signMaterial : material,
}) as unknown as CityMaterials

describe('civic square', () => {
  test('fallback landmarks render and walking axes remain clear around the fountain', () => {
    const square = createCityCenter(mats, new Map())
    square.group.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(square.group)

    expect(bounds.min.x).toBeGreaterThanOrEqual(17)
    expect(bounds.max.x).toBeLessThanOrEqual(94)
    expect(bounds.min.z).toBeGreaterThanOrEqual(-92)
    expect(bounds.max.z).toBeLessThanOrEqual(-14)
    expect(bounds.max.y).toBeGreaterThan(10)
    expect(square.group.children.some((child) => (child as THREE.Mesh).isMesh)).toBe(true)

    // Check actual rectangle overlap, including wide planters and kiosk bounds.
    const overlaps = (b: { minX: number; maxX: number; minZ: number; maxZ: number }, r: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
      b.minX < r.maxX && b.maxX > r.minX && b.minZ < r.maxZ && b.maxZ > r.minZ
    const clearRoutes = [
      { minX: 48, maxX: 52, minZ: -92, maxZ: -60 },
      { minX: 48, maxX: 52, minZ: -44, maxZ: -14 },
      { minX: 17, maxX: 42, minZ: -54, maxZ: -50 },
      { minX: 58, maxX: 94, minZ: -54, maxZ: -50 },
    ]
    for (const route of clearRoutes) {
      for (const collider of square.colliders) expect(overlaps(collider, route)).toBe(false)
    }
    expect(square.colliders.some((b) => b.minX <= 46 && b.maxX >= 54 && b.minZ <= -56 && b.maxZ >= -48)).toBe(true)
  })

  test('returns reusable bench and lamp locations without obstructing the cafe entrance', () => {
    const square = createCityCenter(mats, new Map())
    expect(square.seats).toHaveLength(4)
    expect(square.streetLights).toHaveLength(8)
    expect(square.animated).toBeDefined()
    square.animated!(1.2)

    for (const b of square.colliders) {
      const hitsCafeRoute = b.maxX > 75.5 && b.minX < 80.5 && b.maxZ > -31 && b.minZ < -24
      expect(hitsCafeRoute).toBe(false)
    }
    for (const seat of square.seats) {
      expect(seat.x).toBeGreaterThanOrEqual(17)
      expect(seat.x).toBeLessThanOrEqual(94)
      expect(seat.z).toBeGreaterThanOrEqual(-92)
      expect(seat.z).toBeLessThanOrEqual(-14)
    }
  })
})
