import * as THREE from 'three'

interface Chunk { mesh: THREE.Mesh; bounds: THREE.Box3 }

/** District-wide material batches defeat frustum culling: one visible tree
 * submits every tree. Partition static batches once, preserving each vertex,
 * material group, instance colour and transform. Simulation meshes stay live. */
export class SpatialBatches {
  private chunks: Chunk[] = []
  private originals: THREE.Mesh[] = []
  private point = new THREE.Vector3()
  private matrix = new THREE.Matrix4()
  constructor(private cellSize = 240, private minTriangles = 30_000) {}

  add(root: THREE.Object3D) {
    root.updateWorldMatrix(true, true)
    const meshes: THREE.Mesh[] = []
    root.traverse(node => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh) })
    for (const mesh of meshes) {
      if (!mesh.parent || !mesh.visible || !mesh.frustumCulled || mesh.children.length) continue
      const geometry = mesh.geometry
      if (geometry.morphAttributes.position?.length || (mesh as THREE.SkinnedMesh).isSkinnedMesh) continue
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) this.splitInstances(mesh as THREE.InstancedMesh)
      else this.splitGeometry(mesh)
    }
  }

  private key(point: THREE.Vector3) {
    return `${Math.floor(point.x / this.cellSize)},${Math.floor(point.z / this.cellSize)}`
  }

  private register(mesh: THREE.Mesh) {
    mesh.updateWorldMatrix(true, false)
    // These replacement meshes never move. Their instance/vertex data is static.
    mesh.matrixAutoUpdate = false
    mesh.matrixWorldAutoUpdate = false
    this.chunks.push({ mesh, bounds: new THREE.Box3().setFromObject(mesh) })
  }

  private splitInstances(source: THREE.InstancedMesh) {
    if (source.count < 8 || source.instanceMatrix.usage !== THREE.StaticDrawUsage || source.morphTexture) return
    if ((source.geometry.index?.count ?? source.geometry.attributes.position.count) / 3 * source.count < this.minTriangles) return
    const cells = new Map<string, number[]>()
    for (let i = 0; i < source.count; i++) {
      source.getMatrixAt(i, this.matrix)
      this.point.setFromMatrixPosition(this.matrix).applyMatrix4(source.matrixWorld)
      const key = this.key(this.point)
      if (!cells.has(key)) cells.set(key, [])
      cells.get(key)!.push(i)
    }
    if (cells.size < 2) return
    const parent = source.parent!
    const color = new THREE.Color()
    for (const [key, slots] of cells) {
      const chunk = new THREE.InstancedMesh(source.geometry, source.material, slots.length)
      chunk.copy(source, false)
      // copy() duplicates full-capacity instance buffers; replace with the
      // compact cell allocation, including colour data only when needed.
      chunk.count = slots.length
      chunk.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(slots.length * 16), 16)
      chunk.instanceColor = source.instanceColor ? new THREE.InstancedBufferAttribute(new Float32Array(slots.length * 3), 3) : null
      slots.forEach((slot, i) => {
        source.getMatrixAt(slot, this.matrix)
        chunk.setMatrixAt(i, this.matrix)
        if (source.instanceColor) { source.getColorAt(slot, color); chunk.setColorAt(i, color) }
      })
      chunk.name = `${source.name || 'Static instances'}/${key}`
      chunk.boundingBox = chunk.boundingSphere = null
      chunk.computeBoundingBox()
      chunk.computeBoundingSphere()
      parent.add(chunk)
      this.register(chunk)
    }
    source.visible = false
    this.originals.push(source)
  }

  private splitGeometry(source: THREE.Mesh) {
    const geometry = source.geometry, position = geometry.getAttribute('position')
    if (!position || Object.values(geometry.attributes).some(a => !(a instanceof THREE.BufferAttribute) || a.usage !== THREE.StaticDrawUsage)) return
    const count = geometry.index?.count ?? position.count
    if (count / 3 < this.minTriangles || geometry.drawRange.start !== 0 || geometry.drawRange.count < count) return
    const bounds = new THREE.Box3().setFromObject(source)
    if (Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) < this.cellSize * 2) return
    // Each cell stores triangles by original material group. No welding or
    // simplification: attributes and winding remain identical to the source.
    const cells = new Map<string, Map<number, number[]>>()
    const groups = Array.isArray(source.material) ? geometry.groups : [{ start: 0, count, materialIndex: 0 }]
    for (const group of groups) {
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const a = geometry.index?.getX(i) ?? i, b = geometry.index?.getX(i + 1) ?? i + 1, c = geometry.index?.getX(i + 2) ?? i + 2
        this.point.set((position.getX(a) + position.getX(b) + position.getX(c)) / 3,
          (position.getY(a) + position.getY(b) + position.getY(c)) / 3,
          (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3).applyMatrix4(source.matrixWorld)
        const key = this.key(this.point), material = group.materialIndex ?? 0
        if (!cells.has(key)) cells.set(key, new Map())
        const materials = cells.get(key)!
        if (!materials.has(material)) materials.set(material, [])
        materials.get(material)!.push(a, b, c)
      }
    }
    if (cells.size < 2) return
    const parent = source.parent!
    for (const [key, materials] of cells) {
      const geo = new THREE.BufferGeometry(), vertices: number[] = [], index: number[] = []
      const remap = new Map<number, number>()
      for (const [material, triangles] of materials) {
        const start = index.length
        for (const original of triangles) {
          if (!remap.has(original)) { remap.set(original, vertices.length); vertices.push(original) }
          index.push(remap.get(original)!)
        }
        geo.addGroup(start, index.length - start, material)
      }
      for (const [name, raw] of Object.entries(geometry.attributes)) {
        const attribute = raw as THREE.BufferAttribute
        const ArrayType = attribute.array.constructor as { new(length: number): THREE.TypedArray }
        const data = new ArrayType(vertices.length * attribute.itemSize)
        vertices.forEach((original, i) => {
          for (let c = 0; c < attribute.itemSize; c++) data[i * attribute.itemSize + c] = attribute.array[original * attribute.itemSize + c]
        })
        geo.setAttribute(name, new THREE.BufferAttribute(data, attribute.itemSize, attribute.normalized))
      }
      geo.setIndex(index)
      geo.computeBoundingBox()
      geo.computeBoundingSphere()
      const chunk = source.clone(false)
      chunk.geometry = geo
      chunk.name = `${source.name || 'Static geometry'}/${key}`
      parent.add(chunk)
      this.register(chunk)
    }
    source.visible = false
    this.originals.push(source)
    // Original geometry may be shared by another mesh; release it through the
    // engine's complete scene disposal rather than invalidating other users.
  }

  update(viewer: THREE.Vector3, distance: number) {
    // A district overview sees almost every cell. Use the original broad
    // batches there to avoid paying thousands of small draw calls.
    const overview = distance === Infinity
    for (const original of this.originals) original.visible = overview
    for (const { mesh, bounds } of this.chunks) mesh.visible = !overview && bounds.distanceToPoint(viewer) <= distance
  }

  get count() { return this.chunks.length }
}
