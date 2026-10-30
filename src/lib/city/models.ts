import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export type ModelLibrary = Map<string, THREE.Group>

/** Locally authored Blender assets. Keep a procedural fallback for offline
 * caches or old deployments that have not copied public/models yet. */
export async function loadCityModels(): Promise<ModelLibrary> {
  const library: ModelLibrary = new Map()
  const loader = new GLTFLoader()
  const base = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, '') ?? ''
  const results = await Promise.allSettled(['architecture', 'vehicles', 'street-props', 'civic'].map(async (file) => {
    const gltf = await loader.loadAsync(`${base}/models/${file}.glb`)
    gltf.scene.updateMatrixWorld(true)
    for (const child of gltf.scene.children) {
      if (!(child instanceof THREE.Group) && !child.children.length) continue
      library.set(child.name, child as THREE.Group)
    }
  }))
  results.forEach((result) => {
    if (result.status === 'rejected') console.warn('Blender asset unavailable; using procedural fallback.', result.reason)
  })
  return library
}
