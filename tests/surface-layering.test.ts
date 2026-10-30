/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { createRoadMeshes } from '../src/lib/city/roads'
import type { CityMaterials, CityPlan, RoadSpec } from '../src/lib/city/types'

const asphalt = new THREE.MeshStandardMaterial({ color: '#333333' })
const sidewalk = new THREE.MeshStandardMaterial({ color: '#777777' })
const track = new THREE.MeshStandardMaterial({ color: '#555555' })
const rail = new THREE.MeshStandardMaterial({ color: '#999999' })
const other = new THREE.MeshStandardMaterial()
const mats = new Proxy({ asphalt, sidewalk, track, rail }, {
  get: (target, key) => key === 'asphalt' ? target.asphalt
    : key === 'sidewalk' ? target.sidewalk
    : key === 'tramTrack' ? target.track
    : key === 'metalDark' ? target.rail
    : other,
}) as unknown as CityMaterials

function containsPoint(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, x: number, z: number) {
  const cross = (px: number, pz: number, qx: number, qz: number) => (px - x) * (qz - z) - (pz - z) * (qx - x)
  const a = cross(ax, az, bx, bz)
  const b = cross(bx, bz, cx, cz)
  const c = cross(cx, cz, ax, az)
  return (a > 1e-6 && b > 1e-6 && c > 1e-6) || (a < -1e-6 && b < -1e-6 && c < -1e-6)
}

function topTriangles(group: THREE.Group, material: THREE.Material, y: number, x: number, z: number) {
  const triangles: number[][] = []
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.material !== material) return
    const positions = object.geometry.getAttribute('position')
    const indices = object.geometry.getIndex()
    const vertexCount = indices?.count ?? positions.count
    const vertexAt = (i: number) => indices ? indices.getX(i) : i
    for (let i = 0; i < vertexCount; i += 3) {
      const a = vertexAt(i), b = vertexAt(i + 1), c = vertexAt(i + 2)
      const ys = [positions.getY(a), positions.getY(b), positions.getY(c)]
      if (!ys.every(vertexY => Math.abs(vertexY - y) < 1e-5)) continue
      const xs = [positions.getX(a), positions.getX(b), positions.getX(c)]
      const zs = [positions.getZ(a), positions.getZ(b), positions.getZ(c)]
      if (containsPoint(xs[0], zs[0], xs[1], zs[1], xs[2], zs[2], x, z)) triangles.push(xs)
    }
  })
  return triangles
}

describe('road surface layering', () => {
  test('junction asphalt has one owner instead of overlapping coplanar strips', () => {
    const roads: RoadSpec[] = [
      { id: 'east-west', axis: 'x', coord: 200, from: 150, to: 250, cls: 'collector' },
      { id: 'north-south', axis: 'z', coord: 200, from: 150, to: 250, cls: 'collector' },
    ]
    const blocks = [{ cx: 200, cz: 200, zone: 'residential-medium' }]
    const plan = { roads, blocks, crosswalks: [], trafficLights: [] } as unknown as CityPlan

    // This sample lies inside both 7 m asphalt bands at the junction.
    const city = createRoadMeshes(plan, mats)
    const asphaltTops = topTriangles(city, asphalt, 0.02, 200.731, 201.234)
    const slabTops = topTriangles(city, sidewalk, 0, 200.731, 201.234)
    const cornerTops = topTriangles(city, sidewalk, 0.14, 206.231, 207.307)

    expect(asphaltTops).toHaveLength(1)
    expect(slabTops).toHaveLength(0)
    expect(cornerTops).toHaveLength(1)
  })

  test('split pedestrian street endpoints keep their corner sidewalk tile', () => {
    const roads: RoadSpec[] = [
      { id: 'shopping-west', axis: 'x', coord: 100, from: -250, to: -200, cls: 'local' },
      { id: 'shopping-core', axis: 'x', coord: 100, from: -200, to: 200, cls: 'local', pedestrianOnly: true },
      { id: 'shopping-east', axis: 'x', coord: 100, from: 200, to: 250, cls: 'local' },
      { id: 'north-south-at-west-gate', axis: 'z', coord: -200, from: 50, to: 150, cls: 'collector' },
    ]
    const plan = { roads, blocks: [], crosswalks: [], trafficLights: [] } as unknown as CityPlan
    const city = createRoadMeshes(plan, mats)
    const endpointCorner = topTriangles(city, sidewalk, 0.14, -207.231, 105.307)

    expect(endpointCorner).toHaveLength(1)
  })

  test('the central tram bed and rails have one surface at their crossing', () => {
    const roads: RoadSpec[] = [
      { id: 'tram-east-west', axis: 'x', coord: 0, from: -50, to: 50, cls: 'arterial' },
      { id: 'tram-north-south', axis: 'z', coord: 0, from: -50, to: 50, cls: 'arterial' },
    ]
    const plan = { roads, blocks: [], crosswalks: [], trafficLights: [] } as unknown as CityPlan
    const city = createRoadMeshes(plan, mats)
    const trackTops = topTriangles(city, track, 0.035, 0.731, 1.234)
    const railTops = topTriangles(city, rail, 0.11, 0.851, 0.852)

    expect(trackTops).toHaveLength(1)
    expect(railTops).toHaveLength(1)
  })
})
