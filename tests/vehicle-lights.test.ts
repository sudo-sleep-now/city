/// <reference types="bun-types" />
import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { TrafficSystem } from '../src/lib/city/traffic'
import { planCity } from '../src/lib/city/planner'
import { buildRoadNetwork } from '../src/lib/city/roads'
import { VehicleLightRig } from '../src/lib/city/vehicle-lights'
import type { CityMaterials } from '../src/lib/city/types'
import { LightingRig } from '../src/lib/city/lighting'

const gradient = { addColorStop() {} }
const context = new Proxy({ measureText: () => ({ width: 40 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : () => gradient, set: () => true,
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } as unknown as Document
const material = new THREE.MeshStandardMaterial()
const mats = new Proxy({ signMaterial: () => material }, { get: (target, key) => key in target ? target.signMaterial : material }) as unknown as CityMaterials
const plan = planCity(), viewer = new THREE.Vector3(0, 1.7, 0)
const makeTraffic = () => new TrafficSystem(plan, buildRoadNetwork(plan), mats)

test('braking and day/night changes preserve the exact body transform of every car and bus lens', () => {
  const traffic = makeTraffic()
  const state = traffic as unknown as {
    cars: { typeIdx: number; slot: number; speed: number; serveT: number; brakeHold: number }[]
    carMeshes: { paint: THREE.InstancedMesh; lampF: THREE.InstancedMesh; lampR: THREE.InstancedMesh }[]
    busMeshes: { body: THREE.InstancedMesh; lampF: THREE.InstancedMesh; lampR: THREE.InstancedMesh }
    buses: unknown[]
  }
  const service = state.cars.find(c => c.typeIdx === 4)!
  service.serveT = 5
  service.speed = 0
  const body = new THREE.Matrix4(), lamp = new THREE.Matrix4()
  const tint = new THREE.Color()
  for (const night of [0, 1, 0]) {
    traffic.update(.1, viewer, night)
    expect(service.brakeHold).toBeGreaterThan(0)
    for (const car of state.cars) {
      const meshes = state.carMeshes[car.typeIdx]
      meshes.paint.getMatrixAt(car.slot, body)
      for (const lens of [meshes.lampF, meshes.lampR]) {
        lens.getMatrixAt(car.slot, lamp)
        expect(lamp.elements).toEqual(body.elements)
      }
      meshes.lampF.getColorAt(car.slot, tint)
      expect(tint.r).toBeCloseTo(night ? 1 : .15, 4)
    }
    state.carMeshes[service.typeIdx].lampR.getColorAt(service.slot, tint)
    expect(tint.r).toBe(1) // brakes remain bright while held at a stop
    for (let i = 0; i < state.buses.length; i++) {
      state.busMeshes.body.getMatrixAt(i, body)
      for (const lens of [state.busMeshes.lampF, state.busMeshes.lampR]) {
        lens.getMatrixAt(i, lamp)
        expect(lamp.elements).toEqual(body.elements)
      }
    }
  }
})

test('headlights can change while traffic is paused without changing any car pose', () => {
  const traffic = makeTraffic()
  const before = traffic.getHeadlampEmitters()
  traffic.updateLightAppearance(1)
  expect(traffic.getHeadlampEmitters()).toEqual(before)
  traffic.updateLightAppearance(0)
  expect(traffic.getHeadlampEmitters()).toEqual(before)
})

test('a bounded headlight pool aims forward from real lenses and switches off in daylight', () => {
  const traffic = makeTraffic()
  const emitters = traffic.getHeadlampEmitters()
  const car = emitters[0]
  viewer.set(car.x, 1.7, car.z)
  const rig = new VehicleLightRig()
  rig.update(emitters, viewer, 1)
  const lights = rig.group.children.filter(o => o instanceof THREE.SpotLight) as THREE.SpotLight[]
  expect(lights).toHaveLength(4)
  expect(lights.filter(l => l.intensity > 0).length).toBeGreaterThanOrEqual(2)
  for (const light of lights.slice(0, 2)) {
    const direction = light.target.position.clone().sub(light.position)
    expect(direction.dot(new THREE.Vector3(Math.sin(car.heading), 0, Math.cos(car.heading)))).toBeCloseTo(12, 5)
  }
  for (const light of lights.filter(l => l.intensity > 0)) {
    expect(light.castShadow).toBe(false)
    expect(light.position.y).toBeGreaterThan(.6)
    expect(light.target.position.y).toBeLessThan(light.position.y)
    expect(light.position.distanceTo(light.target.position)).toBeGreaterThan(12)
  }
  rig.update(emitters, viewer, 0)
  expect(lights.every(l => l.intensity === 0)).toBe(true)
  expect(rig.group.children.filter(o => o instanceof THREE.SpotLight)).toHaveLength(4)
})

test('the waste truck has one visible packer body instead of coincident paint and livery boxes', () => {
  const traffic = makeTraffic()
  const state = traffic as unknown as { carMeshes: { paint: THREE.InstancedMesh; extra: THREE.InstancedMesh }[] }
  const truck = state.carMeshes[4]
  truck.extra.geometry.computeBoundingBox()
  const rear = truck.extra.geometry.boundingBox!.min.z
  const ray = new THREE.Raycaster(new THREE.Vector3(.071, 1.83, rear - 1), new THREE.Vector3(0, 0, 1))
  const faces = [truck.paint, truck.extra].flatMap(im => ray.intersectObject(new THREE.Mesh(im.geometry, material)))
    .filter(hit => Math.abs(hit.point.z - rear) < .001)
  expect(faces).toHaveLength(1)
})

test('small camera movements do not slide the sun shadow projection over surfaces', () => {
  const scene = new THREE.Scene(), lighting = new LightingRig(scene)
  lighting.setTime(10)
  const sample = (position: THREE.Vector3) => {
    lighting.update(position)
    scene.updateMatrixWorld(true)
    lighting.sun.shadow.updateMatrices(lighting.sun)
    return new THREE.Vector3(3, 0, -4).project(lighting.sun.shadow.camera)
  }
  const initial = sample(new THREE.Vector3())
  const tiny = sample(new THREE.Vector3(.01, 0, .01))
  expect(tiny.x).toBeCloseTo(initial.x, 6)
  expect(tiny.y).toBeCloseTo(initial.y, 6)
  const moved = sample(new THREE.Vector3(5, 0, -9))
  for (const [axis, size] of [['x', lighting.sun.shadow.mapSize.x], ['y', lighting.sun.shadow.mapSize.y]] as const) {
    const pixels = (moved[axis] - initial[axis]) * size / 2
    expect(pixels).toBeCloseTo(Math.round(pixels), 5)
  }
})
