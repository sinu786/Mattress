// src/viewer.mobile.ts
// Mobile build with feature parity to desktop viewer, plus performance optimizations.
// - Force-centers any GLB by wrapping in a pivot at the origin (consistent framing on phones).
// - Touch rotate works (explicit touchAction + touches mapping).
// - Section names: promote inner "sec N" node names to their parent parts so App.tsx can detect sections.
// - Canvas strictly follows the mount's visible bounds (ResizeObserver + visualViewport).


import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js'
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'


const BASE = (import.meta as any).env?.BASE_URL ?? '/'
const DEFAULT_MODEL_URL = `${BASE}assets/bed.glb`
const DRACO_PATH = `${BASE}draco/`
// ---- Ground style knobs
const GROUND_TINT        = 0xFFFFFF; // mirror tint (darker = moodier)
const GROUND_SHEEN_COLOR = 0xFFFFFF; // film layer color
const GROUND_SHEEN_OPAC  = 0.07;     // film layer opacity
const GROUND_FADE_COLOR  = 0xFFFFFF; // radial fade color
const GROUND_FADE_OPAC   = 0.22;     // radial fade strength



// Tweakables for initial zoom
const INITIAL_FRAME_PADDING = 2.5   // larger = farther, smaller = closer
const INITIAL_ZOOM_FACTOR   = 5   // optional post-fit nudge (<1 in, >1 out), 1=disabled
export type InitOptions = {
  // Lighting (match mobile)
  lightRig?: 'mobile' | 'none'      // default: 'mobile'
  envIntensity?: number             // default: 1.15 (PBR reflections)
  backdropColor?: number | string   // default: 0xf5f7fb
  useACES?: boolean                 // default: true

  scrollScrub?: boolean
  modelUrl?: string
  hdriUrl?: string
  showHDRIBackground?: boolean
  enableShadows?: boolean
  toneMappingExposure?: number
  bloomEnabled?: boolean
  bloomThreshold?: number
  bloomStrength?: number
  bloomRadius?: number
}


export type ViewerHandle = {
  setOrbitTargetByName: (name: string | null, zoomScale?: number) => boolean
  setBlur: (amountPx: number) => void
  setVisibleIndices: (indices: number[] | null) => void

  loadGLB: (fileOrUrl: File | string) => Promise<void>
  dispose: () => void

  // Studio
  setExposure: (expo: number) => void
  setAutoRotate: (enabled: boolean) => void
  resetView: () => void
  dolly?: (k: number) => void

  // XR
  enterVR: () => Promise<void>
  enterAR: () => Promise<void>

  // Focus / parts
  setExplode: (t: number) => void
  setOrbitTargetTo: (index: number | null) => void
  isolateIndex: (i: number | null, dimOpacity?: number) => void
  partCount: () => number
  getPartNames: () => string[]

  // Animation surface
  getAnimations: () => string[]
  playAnimation: (name?: string, fadeSeconds?: number, loopMode?: 'once'|'repeat'|'pingpong') => string | null
  stopAnimation: () => void
  pauseAnimation: () => void
  resumeAnimation: () => void
  setAnimationSpeed: (speed: number) => void

  // Bloom controls
  setBloom: (opts: { enabled?: boolean; threshold?: number; strength?: number; radius?: number }) => void
}

// ---------- Scene locals

let initOpts: InitOptions = {}
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: any = null
let groundGroup: THREE.Group | null = null
let groundMirror: any = null
let groundFade: THREE.Mesh | null = null

let composer: any = null
let renderPass: any = null
let bloomPass: any = null
let outputPass: any = null
let hBlurPass: any = null
let vBlurPass: any = null
let blurAmountPx = 0
let groundFilm: THREE.Mesh | null = null
let modelSpinEnabled = false
let modelSpinSpeed = 0.2 // radians per second (≈11.5°/s) – tweak to taste

let pmrem: THREE.PMREMGenerator | null = null
let autoRotateEnabled = true
let mountEl: HTMLElement | null = null

// Pivot that holds the current GLB (centered at origin)
let pivot: THREE.Group | null = null

// "currentModel" points to the pivot (so AR placement moves the whole)
let currentModel: THREE.Object3D | null = null

let parts: THREE.Object3D[] = []
let partNames: string[] = []
const savedMatProps = new WeakMap<THREE.Material, { transparent: boolean; opacity: number }>()
let bbox = new THREE.Box3()
let centroid = new THREE.Vector3() // logical target (0,0,0 after centering)

// target smoothing
let target_desired = new THREE.Vector3()
const TARGET_LERP = 0.18

// XR helpers
let xrRefSpace: XRReferenceSpace | null = null
let xrHitSource: XRHitTestSource | null = null
let reticle: THREE.Mesh | null = null

// Studio backdrop
let studioBackdrop: THREE.Mesh | null = null


// Animations
let mixer: THREE.AnimationMixer | null = null
let actions: Record<string, THREE.AnimationAction> = {}
let activeAction: THREE.AnimationAction | null = null
let clipNames: string[] = []
let clipDurations: Record<string, number> = {}
let playbackSpeed = 1.0
let explodeState: 0 | 1 = 0

// ===== Smooth zoom for exploded view =====
const EXPLODED_ZOOM_FACTOR = 1.25
const EXPLODED_ZOOM_MS = 380
let _explodedZoomApplied = false
let _zoomAnimRAF: number | null = null
const _easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
function _currentDist(): number {
  if (!camera || !controls) return 0
  return new THREE.Vector3().subVectors(camera.position, controls.target).length()
}
function _setDist(dist: number) {
  if (!camera || !controls) return
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize()
  if (!isFinite(dir.length())) dir.set(0, 0, 1)
  const min = Math.max(controls.minDistance ?? 0.01, 0.01)
  const max = Math.max(controls.maxDistance ?? 1e6, min + 1)
  const d = THREE.MathUtils.clamp(dist, min, max)
  camera.position.copy(controls.target).add(dir.multiplyScalar(d))
  camera.updateProjectionMatrix()
  controls.update()
}
function dollyScaleSmooth(k: number, ms = 380) {
  if (!camera || !controls) return
  if (_zoomAnimRAF !== null) { cancelAnimationFrame(_zoomAnimRAF); _zoomAnimRAF = null }
  const start = _currentDist()
  const end = start * k
  const t0 = performance.now()
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / Math.max(1, ms))
    const e = _easeOutCubic(t)
    const dist = start * Math.pow(end / Math.max(1e-6, start), e)
    _setDist(dist)
    if (t < 1) _zoomAnimRAF = requestAnimationFrame(step)
    else _zoomAnimRAF = null
  }
  _zoomAnimRAF = requestAnimationFrame(step)
}
function applyExplodedZoom() {
  if (_explodedZoomApplied) return
  dollyScaleSmooth(EXPLODED_ZOOM_FACTOR, EXPLODED_ZOOM_MS)
  _explodedZoomApplied = true
}
function clearExplodedZoom() {
  if (!_explodedZoomApplied) return
  dollyScaleSmooth(1 / EXPLODED_ZOOM_FACTOR, EXPLODED_ZOOM_MS)
  _explodedZoomApplied = false
}


// ---------- helpers
function updateGroundHeightFromBBox() {
  if (!scene || !groundGroup) return
  const target = pivot || currentModel || scene
  const box = new THREE.Box3().setFromObject(target)
  if (!isFinite(box.min.y) || !isFinite(box.max.y)) return
  const newY = Math.min(box.min.y, groundBaseY) - GROUND_PAD

  if (groundMirror) (groundMirror as any).position.y = newY
  if (groundFilm)   groundFilm.position.y           = newY + 0.0002
  if (groundFade)   groundFade.position.y           = newY + 0.0003
}



function setEnvIntensity(root: THREE.Object3D, intensity: number) {
  root.traverse((o: any) => {
    if (!o.isMesh) return
    const apply = (m: THREE.Material) => {
      const std = m as any
      if ('envMapIntensity' in std) std.envMapIntensity = intensity
    }
    if (Array.isArray(o.material)) o.material.forEach(apply)
    else if (o.material) apply(o.material)
  })
}


function addMobileLightRig() {
  if (!scene) return

  // Soft ambient (sky/ground), cheap and stable
  const hemi = new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 0.55)
  hemi.position.set(0, 1, 0)
  scene.add(hemi)

  // Key (main directional), no shadows to avoid mobile perf hits/banding
  const key = new THREE.DirectionalLight(0xffffff, 1.35)
  key.position.set(3.0, 3.2, 2.0)
  key.castShadow = false
  scene.add(key)

  // Rim / kicker from behind
  const rim = new THREE.DirectionalLight(0xffffff, 0.8)
  rim.position.set(-2.2, 2.6, -3.2)
  rim.castShadow = false
  scene.add(rim)

  // Gentle fill near camera (keeps faces from going black at glancing angles)
  const fill = new THREE.PointLight(0xffffff, 0.55, 0, 2)
  fill.position.set(0, 1.1, 2.8)
  scene.add(fill)
}

function createReticle() {
  const ringGeo = new THREE.RingGeometry(0.09, 0.1, 32).rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({ color: 0x66bbff })
  const m = new THREE.Mesh(ringGeo, mat)
  m.visible = false
  return m
}
function getWorldPosByName(name: string, out = new THREE.Vector3()): THREE.Vector3 | null {
  if (!scene) return null
  const obj = scene.getObjectByName(name)
  if (!obj) return null
  obj.updateWorldMatrix(true, false)
  out.setFromMatrixPosition(obj.matrixWorld)
  return out
}
async function loadHDRIToEnv(url: string, showBackground: boolean) {
  if (!renderer || !scene) return
  pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()
  const hdr = await new RGBELoader().loadAsync(url)
  hdr.mapping = THREE.EquirectangularReflectionMapping
  const envTex = pmrem.fromEquirectangular(hdr).texture
  hdr.dispose?.()
  scene.environment = envTex
  if (showBackground) scene.background = envTex
}
function addStudioBackdrop() {
  if (!scene) return
  const col = (initOpts.backdropColor ?? 0xf5f7fb) as any

  // Base sphere (inside-out “infinite” studio)
  const geo = new THREE.SphereGeometry(50, 64, 64)
  const mat = new THREE.MeshStandardMaterial({
    color: col,
    roughness: 0.98,
    metalness: 0.0,
    side: THREE.BackSide
  })
  const mesh = new THREE.Mesh(geo, mat)
  // Don’t write depth so overlay lines don’t z-fight and stay visible
  ;(mesh.material as THREE.MeshStandardMaterial).depthWrite = false
  mesh.receiveShadow = false
  mesh.castShadow = false
  scene.add(mesh)
  studioBackdrop = mesh

}


function normalizeImportedLights(root: THREE.Object3D) {
  root.traverse(obj => {
    const l: any = obj
    if (!l.isLight) return
    l.castShadow = false
    if (l.shadow) {
      l.shadow.autoUpdate = false
      l.shadow.needsUpdate = false
      l.shadow.mapSize.set(0, 0)
    }
    if (l.decay !== undefined) l.decay = 2
  })
}


function computeModelStats(obj: THREE.Object3D) {
  bbox.setFromObject(obj)
  bbox.getCenter(centroid)
}
function gatherParts(root: THREE.Object3D): THREE.Object3D[] {
  const set = new Set<THREE.Object3D>()
  root.children.forEach(ch => {
    let hasMesh = false
    ch.traverse(o => { if ((o as any).isMesh) hasMesh = true })
    if (hasMesh) set.add(ch)
  })
  if (set.size === 0) {
    root.traverse(o => {
      const m: any = o
      if (m.isMesh && o.parent) set.add(o.parent)
    })
  }
  return Array.from(set)
}
// Promote inner "sec N" names to their part so getPartNames sees them
function promoteSectionNamesToParts(partsArr: THREE.Object3D[]) {
  const rx = /^(?:\s*(?:sec|se|section)\s*)(\d+)\s*$/i
  partsArr.forEach(p => {
    let chosen: string | null = null
    if (typeof p.name === 'string' && rx.test(p.name.trim())) {
      chosen = p.name
    } else {
      p.traverse(o => {
        if (chosen) return
        const n = (o.name || '').trim()
        if (n && rx.test(n)) chosen = n
      })
    }
    if (chosen) p.name = chosen
  })
}
// Clone materials and remember base opacity
function cloneMaterials(root: THREE.Object3D) {
  root.traverse((o: any) => {
    if (!o.isMesh) return
    const wrap = (m: THREE.Material) => {
      const baseTransparent = (m as any).transparent ?? false
      const raw = (m as any).opacity
      const baseOpacity = (typeof raw === 'number' && raw > 0.1) ? raw : 1
      const c = m.clone()
      ;(c as any).transparent = true
      ;(c as any).opacity = baseOpacity
      ;(c as any).depthWrite = true
      ;(c as any).alphaTest = (m as any).alphaTest ?? 0
      savedMatProps.set(c, { transparent: baseTransparent, opacity: baseOpacity })
      return c
    }
    if (Array.isArray(o.material)) o.material = o.material.map(wrap)
    else if (o.material) o.material = wrap(o.material)
  })
}

function isolatePart(index: number | null, dimOpacity = 0.22) {
  const dim = Math.max(0.08, Math.min(0.5, dimOpacity))
  parts.forEach((p, i) => {
    p.visible = true
    p.traverse((o: any) => {
      if (!o.isMesh) return
      const apply = (m: THREE.Material) => {
        const saved = savedMatProps.get(m)
        const base = saved?.opacity ?? 1
        ;(m as any).transparent = true
        ;(m as any).opacity = (index === null || i === index) ? Math.max(0.98, base) : dim
        ;(m as any).depthWrite = true
        ;(m as any).colorWrite = true
      }
      if (Array.isArray(o.material)) o.material.forEach(apply)
      else if (o.material) apply(o.material)
    })
  })
}
function getPartWorldCenter(index: number, out = new THREE.Vector3()) {
  const p = parts[index]
  const tmp = new THREE.Box3().setFromObject(p)
  return tmp.getCenter(out)
}
function applyVisibilityMask(indices: number[] | null) {
  const keep = indices ? new Set(indices) : null
  parts.forEach((p, i) => {
    const allow = keep ? keep.has(i) : true
    p.visible = allow
    p.traverse((o: any) => {
      if (!o.isMesh || !o.material) return
      const use = (m: THREE.Material) => {
        const saved = savedMatProps.get(m)
        const base = saved?.opacity ?? 1
        ;(m as any).transparent = true
        ;(m as any).opacity = allow ? Math.max(0.98, base) : 0.0
        ;(m as any).depthWrite = true
        ;(m as any).colorWrite = allow
      }
      if (Array.isArray(o.material)) o.material.forEach(use)
      else use(o.material)
    })
  })
}

// Center root under a pivot so model origin == model center
function centerRootUnderPivot(root: THREE.Object3D) {
  if (!scene) return
  if (!pivot) {
    pivot = new THREE.Group()
    pivot.name = 'Pivot'
    scene.add(pivot)
  } else {
    while (pivot.children.length) pivot.remove(pivot.children[0])
  }

  const box = new THREE.Box3().setFromObject(root)
  const c = new THREE.Vector3()
  box.getCenter(c)
  root.position.sub(c)
  root.updateMatrixWorld(true)

  pivot.add(root)
  currentModel = pivot

  centroid.set(0, 0, 0)
}

// ---------- Public init
export async function initViewer(container: HTMLElement, opts: InitOptions = {}): Promise<ViewerHandle> {

  initOpts = { lightRig: 'mobile', envIntensity: .5, backdropColor: 0xFFFFFF, useACES: true, ...opts }

  mountEl = container

  // Renderer (mobile-lean)
  renderer = new THREE.WebGLRenderer({
    antialias : true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    preserveDrawingBuffer: false,
  })

    // Color management & tonemapping (mobile-friendly studio look)
    renderer.outputColorSpace = THREE.SRGBColorSpace as any
    renderer.toneMapping = (opts.useACES ?? true)
      ? THREE.ACESFilmicToneMapping
      : THREE.NoToneMapping
    renderer.toneMappingExposure = opts.toneMappingExposure ?? 1.15
  
  const dprCap = 2
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap))
  // Canvas element must obey container bounds exactly
  container.appendChild(renderer.domElement)
  const cvs = renderer.domElement as HTMLCanvasElement
  cvs.style.position = 'absolute'
  cvs.style.inset = '0'
  cvs.style.width = '100%'
  cvs.style.height = '100%'
  cvs.style.display = 'block'
  ;(cvs.style as any).touchAction = 'none' // important for OrbitControls

  // size to visible bounds
  const sizeToContainer = () => {
    if (!renderer || !camera) return
    const rect = container.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    renderer.setSize(w, h, true)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    composer?.setSize(w, h)
    bloomPass?.setSize(w, h)
    if (hBlurPass?.uniforms?.h) hBlurPass.uniforms.h.value = blurAmountPx / w
    if (vBlurPass?.uniforms?.v) vBlurPass.uniforms.v.value = blurAmountPx / h
  }
  sizeToContainer()
  const ro = new ResizeObserver(sizeToContainer)
  ro.observe(container)
  window.addEventListener('orientationchange', sizeToContainer)
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', sizeToContainer)
    window.visualViewport.addEventListener('scroll', sizeToContainer)
  }

  // Scene + Camera
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xffffff)
  camera = new THREE.PerspectiveCamera(50, 1, 0.01, 20000)
  camera.position.set(0, 1, 3)
  scene.add(camera)

  // Environment
  if (opts.hdriUrl) {
    try { await loadHDRIToEnv(opts.hdriUrl, !!opts.showHDRIBackground) }
    catch (e) { console.warn('HDRI load failed, using RoomEnvironment', e) }
  }
  if (!scene.environment) {
    pmrem = new THREE.PMREMGenerator(renderer)
    const env = new RoomEnvironment()
    const envTex = pmrem.fromScene(env, 0.04).texture
    scene.environment = envTex
    if (opts.showHDRIBackground) scene.background = envTex
  }

  // Backdrop
  addStudioBackdrop()

  if ((initOpts.lightRig ?? 'mobile') !== 'none') addMobileLightRig()


  // PostFX
  composer = new EffectComposer(renderer)
  renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)

  hBlurPass = new ShaderPass(HorizontalBlurShader)
  vBlurPass = new ShaderPass(VerticalBlurShader)
  hBlurPass.enabled = false
  vBlurPass.enabled = false
  composer.addPass(hBlurPass)
  composer.addPass(vBlurPass)

  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1),
  opts.bloomStrength ?? 0.1,
  opts.bloomRadius ?? 0.22,
  opts.bloomThreshold ?? 0.8
  )
  bloomPass.enabled = opts.bloomEnabled ?? true
  composer.addPass(bloomPass)

  outputPass = new OutputPass()
  composer.addPass(outputPass)
  renderer.setClearColor(0x0b1220, 1)
  scene.background = new THREE.Color(0x0b1220) // premium studio vibe
  
  // Reticle (AR)
  reticle = createReticle()
  scene.add(reticle)

  // Controls
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.enablePan = false
  controls.enableZoom = false
  controls.enableRotate = true
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN } // explicit
  controls.autoRotate = autoRotateEnabled
  controls.autoRotateSpeed = 0
  controls.minDistance = 0.15
  controls.maxDistance = 20000
  controls.maxPolarAngle = Math.PI * 0.5

  // Animate
  const clock = new THREE.Clock()
  const renderFrame = () => {
    const dt = clock.getDelta()
    if (controls) {
      const lerpAmt = 1 - Math.pow(1 - TARGET_LERP, dt * 60)
      controls.target.lerp(target_desired, lerpAmt)
      controls.update()
    }
    if (mixer) mixer.update(dt * playbackSpeed)

      if (modelSpinEnabled && pivot) {
        pivot.rotation.y += modelSpinSpeed * dt
      }
      
      if (groundFollow) updateGroundHeightFromBBox()


    if (renderer?.xr?.isPresenting) {
      renderer.render(scene!, camera!)
    } else if (composer) {
      composer.render()
    } else {
      renderer!.render(scene!, camera!)
    }
  }
  renderer.setAnimationLoop(renderFrame)

  // Load initial model
  await loadGLB(opts.modelUrl ?? DEFAULT_MODEL_URL)

  target_desired.copy(centroid)

  return {

    setOrbitTargetByName: (name: string | null) => {
      if (!controls) return false
      if (!name) { target_desired.copy(centroid); return true }
      const pos = getWorldPosByName(name)
      if (!pos) return false
      target_desired.copy(pos)
      return true
    },

    setVisibleIndices: (indices: number[] | null) => applyVisibilityMask(indices),

    setBlur: (amountPx: number) => {
      blurAmountPx = Math.max(0, amountPx | 0)
      if (!renderer || !composer) return
      const size = renderer.getSize(new THREE.Vector2())
      const w = Math.max(1, size.x)
      const h = Math.max(1, size.y)
      const on = blurAmountPx > 0
      if (hBlurPass && vBlurPass) {
        hBlurPass.enabled = on
        vBlurPass.enabled = on
        if (on) {
          hBlurPass.uniforms.h.value = blurAmountPx / w
          vBlurPass.uniforms.v.value = blurAmountPx / h
        }
      }
    },

    loadGLB,
    dispose: () => {

      if (groundGroup) {
        groundGroup.traverse((o: any) => {
          if (o.geometry) o.geometry.dispose?.()
          if (o.material) o.material.dispose?.()
        })
        scene?.remove(groundGroup)
        groundGroup = null
        groundMirror = null
        groundFade = null
      }
      
      if (_zoomAnimRAF !== null) { cancelAnimationFrame(_zoomAnimRAF); _zoomAnimRAF = null }
      _explodedZoomApplied = false

      ro.disconnect?.()
      window.removeEventListener('orientationchange', sizeToContainer)
      window.visualViewport?.removeEventListener('resize', sizeToContainer)
      window.visualViewport?.removeEventListener('scroll', sizeToContainer)

      if (renderer) renderer.setAnimationLoop(null)

      if (studioBackdrop) {
        studioBackdrop.geometry?.dispose?.()
        ;(studioBackdrop.material as any)?.dispose?.()
        scene?.remove(studioBackdrop)
        studioBackdrop = null
      }

      if (pivot) {
        pivot.traverse((n: any) => {
          if (n.isMesh) {
            n.geometry?.dispose?.()
            if (Array.isArray(n.material)) n.material.forEach((m: any) => m.dispose?.())
            else n.material?.dispose?.()
          }
        })
        scene?.remove(pivot)
        pivot = null
      }

      if (renderer) { renderer.dispose(); renderer = null }
      if (mixer) { mixer.stopAllAction(); mixer = null }
      actions = {}; activeAction = null; clipNames = []; clipDurations = {}
      controls?.dispose(); controls = null
      pmrem?.dispose(); pmrem = null
      scene = null; camera = null; currentModel = null; reticle = null
      parts = []; partNames = []; explodeState = 0
    },

    // Studio
    setExposure: (expo: number) => { if (renderer) renderer.toneMappingExposure = expo },
    setAutoRotate: (enabled: boolean) => { autoRotateEnabled = enabled; if (controls) controls.autoRotate = enabled },
    resetView: () => { if (controls) { controls.target.copy(centroid); target_desired.copy(centroid) } },
    dolly: (k: number) => {
      if (!camera || !controls) return
      const dir = new THREE.Vector3().subVectors(camera.position, controls.target)
      const dist = dir.length()
      const min = Math.max(controls.minDistance ?? 0.01, 0.01)
      const max = Math.max(controls.maxDistance ?? 1e6, min + 1)
      const newDist = THREE.MathUtils.clamp(dist * k, min, max)
      dir.setLength(newDist)
      camera.position.copy(controls.target).add(dir)
      camera.updateProjectionMatrix()
      controls.update()
    },

    // XR
    enterVR: async () => {
      if (!renderer) return
      if (!(navigator as any).xr) { alert('WebXR not available in this browser.'); return }
      const session = await (navigator as any).xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] })
      await (renderer.xr as any).setSession(session)
    },
    enterAR: async () => {
      if (!renderer) return
      if (!(navigator as any).xr) { alert('WebXR not available in this browser.'); return }

      try {
        const sessionInit: XRSessionInit = {
          requiredFeatures: ['hit-test', 'local-floor'],
          optionalFeatures: ['dom-overlay'],
          domOverlay: { root: mountEl! }
        } as any

        const session = await (navigator as any).xr.requestSession('immersive-ar', sessionInit)
        await (renderer.xr as any).setSession(session)

        xrRefSpace = await session.requestReferenceSpace('local')
        const viewerSpace = await session.requestReferenceSpace('viewer')
        xrHitSource = await (session as any).requestHitTestSource({ space: viewerSpace })

        session.addEventListener('select', () => {
          if (reticle && currentModel) {
            currentModel.position.setFromMatrixPosition(reticle.matrix)
            currentModel.visible = true
          }
        })

        const onXRFrame = (_time: number, frame: XRFrame) => {
          frame.getViewerPose(xrRefSpace!)
          if (xrHitSource) {
            const hits = frame.getHitTestResults(xrHitSource)
            if (hits.length && reticle) {
              const hitPose = hits[0].getPose(xrRefSpace!)
              if (hitPose) {
                reticle.visible = true
                reticle.matrix.fromArray(hitPose.transform.matrix)
                reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale)
              }
            } else if (reticle) reticle.visible = false
          }
          renderer!.render(scene!, camera!)
          frame.session.requestAnimationFrame(onXRFrame)
        }
        ;(session as any).requestAnimationFrame(onXRFrame)
      } catch (err) {
        console.error('Failed to start AR session', err)
        alert('Failed to start AR session on this device.')
      }
    },

    // Explosion/animation
    setExplode: (t: number) => {
      
      if (!mixer || !Object.keys(actions).length) return
      t = THREE.MathUtils.clamp(t, 0, 1)

      if (t <= 0) {
        if (explodeState === 1) {
          Object.entries(actions).forEach(([name, a]) => {
            const dur = clipDurations[name] ?? a.getClip().duration
            a.enabled = true
            a.setLoop(THREE.LoopOnce, 0)
            a.clampWhenFinished = true
            a.reset()
            a.setEffectiveWeight(1)
            a.setEffectiveTimeScale(-1)
            a.time = Math.max(0, dur - 1e-6)
            a.paused = false
            a.play()
          })
        } else {
          Object.values(actions).forEach(a => {
            a.enabled = true
            a.setLoop(THREE.LoopOnce, 0)
            a.clampWhenFinished = true
            a.reset()
            a.paused = true
            a.setEffectiveWeight(1)
            a.setEffectiveTimeScale(1)
            a.time = 0
          })
          mixer.update(1e-6)
        }
        clearExplodedZoom()
        explodeState = 0
        return
      }

      if (t >= 1) {
        if (explodeState === 1) {
          Object.entries(actions).forEach(([name, a]) => {
            const dur = clipDurations[name] ?? a.getClip().duration
            a.enabled = true
            a.setLoop(THREE.LoopOnce, 0)
            a.clampWhenFinished = true
            a.reset()
            a.paused = true
            a.setEffectiveWeight(1)
            a.setEffectiveTimeScale(1)
            a.time = dur
          })
          mixer.update(1e-6)
        } else {
          Object.values(actions).forEach(a => {
            a.enabled = true
            a.setLoop(THREE.LoopOnce, 0)
            a.clampWhenFinished = true
            a.reset()
            a.setEffectiveWeight(1)
            a.setEffectiveTimeScale(1)
            a.paused = false
            a.play()
          })
        }
        applyExplodedZoom()
        explodeState = 1
        return
      }

      // Scrub (0..1)
      Object.entries(actions).forEach(([name, a]) => {
        const dur = clipDurations[name] ?? a.getClip().duration
        a.enabled = true
        a.play()
        a.paused = true
        a.setEffectiveWeight(1)
        a.time = dur * t
      })
      mixer.update(0)
    },

    setOrbitTargetTo: (index: number | null) => {
      if (!controls) return
      if (index === null || index < 0 || index >= parts.length) {
        target_desired.copy(centroid)
      } else {
        const c = getPartWorldCenter(index)
        target_desired.copy(c)
      }
    },
    isolateIndex: (i: number | null, dimOpacity = 0.22) => isolatePart(i, dimOpacity),
    partCount: () => parts.length,
    getPartNames: () => [...partNames],

    // Animation API
    getAnimations: () => [...clipNames],
    playAnimation: (name?: string, fadeSeconds = 0.25, loopMode: 'once'|'repeat'|'pingpong' = 'repeat'): string | null => {
      if (!mixer || clipNames.length === 0) return null
      const target = name && actions[name] ? name : clipNames[0]
      const next = actions[target]
      if (!next) return null
      if (loopMode === 'once') { next.setLoop(THREE.LoopOnce, 0); next.clampWhenFinished = true }
      else if (loopMode === 'pingpong') { next.setLoop(THREE.LoopPingPong, Infinity); next.clampWhenFinished = false }
      else { next.setLoop(THREE.LoopRepeat, Infinity); next.clampWhenFinished = false }
      if (activeAction && activeAction !== next) {
        activeAction.crossFadeTo(next.reset().play(), fadeSeconds, false)
      } else {
        next.reset().fadeIn(fadeSeconds).play()
      }
      activeAction = next
      return target
    },
    stopAnimation: () => { if (mixer) mixer.stopAllAction(); activeAction = null },
    pauseAnimation: () => { if (activeAction) activeAction.paused = true },
    resumeAnimation: () => { if (activeAction) activeAction.paused = false },
    setAnimationSpeed: (speed: number) => {
      playbackSpeed = Math.max(0, speed)
      Object.values(actions).forEach(a => a.setEffectiveTimeScale(Math.sign(a.getEffectiveTimeScale()) || 1))
    },

    setBloom: ({ enabled, threshold, strength, radius }) => {
      if (typeof enabled === 'boolean' && bloomPass) bloomPass.enabled = enabled
      if (typeof threshold === 'number' && bloomPass) bloomPass.threshold = threshold
      if (typeof strength === 'number' && bloomPass) bloomPass.strength = strength
      if (typeof radius === 'number' && bloomPass) bloomPass.radius = radius
    },
  
  }
}

export function disposeViewer(h: ViewerHandle) { h.dispose() }
const REFLECT_RES_SCALE = 0.25 // keep if you like the softer reflection

let groundBaseY = 0
let groundFollow = true
const GROUND_PAD = 0.01

function addReflectiveGround(y: number) {
  if (!scene || !renderer) return

  // cleanup previous
  if (groundGroup) {
    groundGroup.traverse((o: any) => {
      if (o.geometry) o.geometry.dispose?.()
      if (o.material) o.material.dispose?.()
    })
    scene.remove(groundGroup)
  }
  groundGroup = new THREE.Group()
  scene.add(groundGroup)

  const radius = 40
  const segs = 128

  const pxRatio = Math.min(renderer.getPixelRatio(), 2)
  const width  = Math.round((renderer.domElement.width  || 1600) * 0.6 * pxRatio * REFLECT_RES_SCALE)
  const height = Math.round((renderer.domElement.height ||  900) * 0.6 * pxRatio * REFLECT_RES_SCALE)

  // --- MIRROR (Reflector)
  groundMirror = new Reflector(
    new THREE.CircleGeometry(radius, segs),
    {
      clipBias: 0.003,
      textureWidth: width,
      textureHeight: height,
      color: GROUND_TINT,
    }
  )
  // ⬇️ these were missing
  groundMirror.rotateX(-Math.PI / 2)
  groundMirror.position.set(0, y, 0)
  ;(groundMirror as any).material.depthWrite = false
  ;(groundMirror as any).material.polygonOffset = true
  ;(groundMirror as any).material.polygonOffsetFactor = 0
  ;(groundMirror as any).material.polygonOffsetUnits = -2
  ;(groundMirror as any).renderOrder = 0
  groundGroup.add(groundMirror as unknown as THREE.Object3D)

  // --- FILM (subtle glossy veil)
  groundFilm = new THREE.Mesh(
    new THREE.CircleGeometry(radius, segs),
    new THREE.MeshStandardMaterial({
      color: GROUND_SHEEN_COLOR,
      roughness: 0.88,
      metalness: 0.0,
      transparent: true,
      opacity: GROUND_SHEEN_OPAC,
      depthWrite: false,
    })
  )
  groundFilm.rotateX(-Math.PI / 2)
  groundFilm.position.set(0, y + 0.0002, 0)
  groundFilm.renderOrder = 1
  groundGroup.add(groundFilm)

  // --- FADE (no hard edge)
  const fadeGeo = new THREE.CircleGeometry(radius, segs)
  const fadeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uColor:   { value: new THREE.Color(GROUND_FADE_COLOR) },
      uOpacity: { value: GROUND_FADE_OPAC },
      uInner:   { value: 0.15 },
      uOuter:   { value: 0.98 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uInner;
      uniform float uOuter;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float d = length(p);
        float a = 1.0 - smoothstep(uInner, uOuter, d);
        gl_FragColor = vec4(uColor, a * uOpacity);
      }
    `
  })
  groundFade = new THREE.Mesh(fadeGeo, fadeMat)
  groundFade.rotateX(-Math.PI / 2)
  groundFade.position.set(0, y + 0.0003, 0)
  groundFade.renderOrder = 2
  groundGroup.add(groundFade)
}



// ---------- Load GLB
async function loadGLB(fileOrUrl: File | string) {
  if (!scene) return

  if (_zoomAnimRAF !== null) { cancelAnimationFrame(_zoomAnimRAF); _zoomAnimRAF = null }
  _explodedZoomApplied = false

  // Clear previous model (pivot and children)
  if (pivot) {
    pivot.traverse((n: any) => {
      if (n.isMesh) {
        n.geometry?.dispose?.()
        if (Array.isArray(n.material)) n.material.forEach((m: any) => m.dispose?.())
        else n.material?.dispose?.()
      }
    })
    scene.remove(pivot)
    pivot = null
  }
  currentModel = null
  if (mixer) { mixer.stopAllAction(); mixer = null }
  actions = {}; activeAction = null; clipNames = []; clipDurations = {}
  parts = []; partNames = []
  explodeState = 0

  const loader = new GLTFLoader()
  try {
    const draco = new DRACOLoader()
    draco.setDecoderPath(DRACO_PATH)
    loader.setDRACOLoader(draco)
  } catch {
    console.warn('DRACOLoader not available; loading without it.')
  }

  const url = (typeof fileOrUrl === 'string') ? fileOrUrl : URL.createObjectURL(fileOrUrl)

  await new Promise<void>((resolve, reject) => {
    loader.load(
      url,
      (gltf: any) => {
        const root = gltf.scene || (gltf.scenes && gltf.scenes[0])
        if (!root) { reject(new Error('GLTF has no scene')); return }

        // Mesh setup
        root.traverse((obj: any) => {
          if (obj.isMesh) {
            // Mobile: avoid real-time shadows (banding + perf), lean on env + rig
            obj.castShadow = false
            obj.receiveShadow = false
          }

        })

        cloneMaterials(root)
        normalizeImportedLights(root)

        // Subtle reflection boost for a clean studio look
        setEnvIntensity(root, initOpts.envIntensity ?? 1.15)


        // Center under pivot and add to scene
        centerRootUnderPivot(root)
        scene!.add(pivot!)

        // Build parts and promote section names if inner nodes carry them
        parts = gatherParts(root)
        promoteSectionNamesToParts(parts)
        partNames = parts.map((p, i) => p.name || `Part ${i + 1}`)

        // Stats based on pivot (now centered at origin)
        computeModelStats(pivot!)

        // One-time fit to view using centered pivot
        fitCameraToObject(pivot!, INITIAL_FRAME_PADDING)
        if (INITIAL_ZOOM_FACTOR !== 5) dollyScaleSmooth(INITIAL_ZOOM_FACTOR, 0)

        // Animations
        if (gltf.animations && gltf.animations.length) {
          mixer = new THREE.AnimationMixer(root) // animate the content inside pivot
          gltf.animations.forEach((clip: THREE.AnimationClip, i: number) => {
            const name = clip.name?.length ? clip.name : `Clip_${i}`
            const action = mixer!.clipAction(clip)
            action.enabled = true
            action.setLoop(THREE.LoopOnce, 0)
            action.clampWhenFinished = true
            action.reset()
            action.paused = true
            action.setEffectiveWeight(1)
            action.setEffectiveTimeScale(1)
            actions[name] = action
            clipNames.push(name)
            clipDurations[name] = clip.duration
          })
          mixer.update(1e-6)
          explodeState = 0
        }

        if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url as string)
        resolve()
      },
      undefined,
      (err) => { console.error('[GLTFLoader] failed', err); reject(err) }
    )
  })

  // Place ground at model base with a tiny offset
const baseY = bbox.min.y - 0.001
addReflectiveGround(baseY)
// Place ground at model base with a tiny offset
groundBaseY = bbox.min.y - GROUND_PAD
addReflectiveGround(groundBaseY)

}

// Fit camera to object (centered pivot)
function fitCameraToObject(obj: THREE.Object3D, padding = 1.2) {
  if (!camera || !controls) return
  const box = new THREE.Box3().setFromObject(obj)
  if (!isFinite(box.min.x) || !isFinite(box.max.x)) return
  const size = new THREE.Vector3(), center = new THREE.Vector3()
  box.getSize(size); box.getCenter(center)
  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = THREE.MathUtils.degToRad(camera.fov)
  const dist = (maxDim / (2 * Math.tan(fov / 2))) * padding

  const viewDir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize()
  if (!isFinite(viewDir.length())) viewDir.set(0, 0, 1)

  camera.position.copy(center).add(viewDir.multiplyScalar(dist))
  camera.near = Math.max(0.01, dist / 100)
  camera.far = Math.max(camera.near * 10, dist * 50)
  camera.updateProjectionMatrix()
  controls.target.copy(center) // ~ (0,0,0)
  controls.update()
}
