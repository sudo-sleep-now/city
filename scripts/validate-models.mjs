globalThis.ProgressEvent = class ProgressEvent extends Event { constructor(type,init){super(type);Object.assign(this,init)} };
import fs from 'node:fs/promises';
const base=new URL('..', import.meta.url).pathname.replace(/\/$/, '');
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
const expectedRoots={
 architecture:['house_gable','house_hip','townhouse','apartment_ground','apartment_floor','apartment_roof','house_modern','terrace_bay','corner_shop','office_stepped','office_lantern'],
 vehicles:['sedan','estate','van','wheel'],
 'street-props':['hydrant','parked_bike','bike_rack','stop_shelter','ticket_kiosk','station_bench','litter_bin'],
 civic:['civic_clock','civic_fountain','market_kiosk'],
};
for(const file of Object.keys(expectedRoots)){
 const data=await fs.readFile(base+'/public/models/'+file+'.glb');
 const dv=new DataView(data.buffer,data.byteOffset,data.byteLength);const len=dv.getUint32(12,true);
 const doc=JSON.parse(data.subarray(20,20+len).toString());
 // Parse geometry without browser texture decoding, preserving node transforms.
 for(const m of doc.materials??[]) {delete m.pbrMetallicRoughness?.baseColorTexture;delete m.normalTexture;delete m.emissiveTexture;delete m.occlusionTexture;delete m.pbrMetallicRoughness?.metallicRoughnessTexture;}
 delete doc.textures;delete doc.images;delete doc.samplers;
 const gltf=await new GLTFLoader().parseAsync(JSON.stringify({...doc,buffers:[{byteLength:dv.getUint32(20+len,true),uri:'data:application/octet-stream;base64,'+data.subarray(28+len).toString('base64')}]}),'');
 gltf.scene.updateMatrixWorld(true);
 const expected=expectedRoots[file];
 for(const name of expected)if(!gltf.scene.children.some(root=>root.name===name))throw Error('Missing authored model: '+name);
 let totalTris=0;
 for(const root of gltf.scene.children){ const inv=root.matrixWorld.clone().invert();const box=new THREE.Box3(); let tris=0;
 root.traverse(n=>{if(!n.isMesh)return;const g=n.geometry.clone().applyMatrix4(inv.clone().multiply(n.matrixWorld));g.computeBoundingBox();box.union(g.boundingBox);tris+=(g.index?.count??g.attributes.position.count)/3;});
 console.log(file,root.name,'bounds',box.min.toArray().map(n=>+n.toFixed(2)),box.max.toArray().map(n=>+n.toFixed(2)),'triangles',tris);
 if(file==='vehicles' && root.name!=='wheel'){const d=box.getSize(new THREE.Vector3());if(d.y>3||d.z<4||d.x>2.8)throw Error('Vehicle axis/scale invalid: '+root.name);}
 if(file==='street-props'){
  const maxSizes={hydrant:[.8,1.15,.8],parked_bike:[.75,1.3,2.1],bike_rack:[.2,.9,1.0],stop_shelter:[4.6,2.8,1.85],ticket_kiosk:[.85,1.85,.65],station_bench:[2.6,1.1,.8],litter_bin:[.7,1.1,.7]};
  const dims=box.getSize(new THREE.Vector3()).toArray();
  if(box.min.y<-.01||box.min.y>.02||dims.some((n,i)=>!Number.isFinite(n)||n<=0||n>maxSizes[root.name][i]))throw Error('Street prop origin/scale invalid: '+root.name);
 }
 if(file==='civic'){
  const maxSizes={civic_clock:[3.6,11.5,3.6],civic_fountain:[8.1,2.5,8.1],market_kiosk:[4.8,3.8,4.0]};
  const dims=box.getSize(new THREE.Vector3()).toArray();
  if(box.min.y<-.01||box.min.y>.025||dims.some((n,i)=>!Number.isFinite(n)||n<=0||n>maxSizes[root.name][i]))throw Error('Civic model origin/scale invalid: '+root.name);
 }
 totalTris+=tris;
 }
 if(file==='street-props' && (totalTris>20000||data.byteLength>900000))throw Error('Street prop bundle exceeds geometry/download budget');
 if(file==='civic' && (totalTris>20000||data.byteLength>900000))throw Error('Civic bundle exceeds geometry/download budget');
}
