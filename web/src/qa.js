// QA-only entry: renders the splat + boxes from a camera given in the URL hash.
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight); document.body.style.margin = 0;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101216);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.02, 100);
const q = new URLSearchParams(location.search);
const eye = (q.get("eye") || "0,1.6,-3").split(",").map(Number);
const tgt = (q.get("t") || "0,1,1").split(",").map(Number);
camera.position.set(...eye); camera.lookAt(...tgt);
scene.add(new SparkRenderer({ renderer }));
const splat = new SplatMesh({ url: q.get("splat") || "/data/scene.splat" });
scene.add(splat);
if (q.get("boxes") !== "0") {
  const data = await (await fetch("/data/scene_objects.json")).json();
  for (const o of data.objects) {
    const g = new THREE.BoxGeometry(...o.size);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: o.kind === "structure" ? 0xff4444 : 0xffcc00 }));
    e.position.set(...o.center); e.rotation.y = -o.yaw; scene.add(e);
  }
}
await splat.initialized;
const t0 = performance.now(); let frames = 0;
renderer.setAnimationLoop(() => { renderer.render(scene, camera); frames++;
  if (performance.now() - t0 > (+q.get("wait") || 15000) && frames > 3) { renderer.setAnimationLoop(null); renderer.render(scene, camera); window.__ready = true; } });
