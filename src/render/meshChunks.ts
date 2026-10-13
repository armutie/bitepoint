import * as THREE from 'three'

/** Partition immutable world-space triangles while preserving every authored vertex attribute. */
export function chunkGeometry(source: THREE.BufferGeometry, metres = 64): THREE.BufferGeometry[] {
  const position = source.getAttribute('position'), index = source.index
  const count = index?.count ?? position.count
  const attributes = Object.entries(source.attributes)
  const chunks = new Map<string, Map<string, number[]>>()
  for (let triangle = 0; triangle < count; triangle += 3) {
    const vertices = [0,1,2].map(v => index ? index.getX(triangle+v) : triangle+v)
    const x = vertices.reduce((sum,v)=>sum+position.getX(v),0)/3
    const z = vertices.reduce((sum,v)=>sum+position.getZ(v),0)/3
    const key = Math.floor(x/metres)+','+Math.floor(z/metres)
    let chunk = chunks.get(key)
    if (!chunk) { chunk = new Map(attributes.map(([name])=>[name,[]])); chunks.set(key,chunk) }
    for (const [name,attribute] of attributes) {
      const output = chunk.get(name)!
      for (const vertex of vertices) for(let component=0;component<attribute.itemSize;component++) output.push(attribute.getComponent(vertex,component))
    }
  }
  return [...chunks.values()].map(chunk => {
    const geometry = new THREE.BufferGeometry()
    for (const [name,attribute] of attributes) geometry.setAttribute(name,new THREE.Float32BufferAttribute(chunk.get(name)!,attribute.itemSize))
    geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry
  })
}
