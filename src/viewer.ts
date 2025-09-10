// src/viewer.ts
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

// Post FX
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js'
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js'

// ---- Vite/Vercel-safe base paths for static assets under /public
const BASE = (import.meta as any).env?.BASE_URL ?? '/'
const DEFAULT_MODEL_URL = `${BASE}assets/bed.glb`
const DRACO_PATH = `${BASE}draco/` // ensure public/draco/* files exist

// ---------- Types
export type InitOptions = {
  scrollScrub?: boolean
  modelUrl?: string
  hdriUrl?: string
  showHDRIBackground?: boolean
  enableShadows?: boolean
  toneMappingExposure?: number
  // Bloom
  bloomEnabled?: boolean
  bloomThreshold?: number
  bloomStrength?: number
  bloomRadius?: number
}

export type ViewerHandle = {
  // Target by name (e.g., Blender Empty like "sec1.001")
  setOrbitTargetByName: (name: string | null, zoomScale?: number) => boolean
  // Global blur (screen blur) controls
  setBlur: (amountPx: number) => void          // 0 disables

  // NEW: visibility mask (null = show all, list = show only those parts)
  setVisibleIndices: (indices: number[] | null) => void

  loadGLB: (fileOrUrl: File | string) => Promise<void>
  dispose: () => void

  // Studio
  setExposure: (expo: number) => void
  setAutoRotate: (enabled: boolean) => void
  resetView: () => void
  dolly?: (k: number) => void // k>1 zoom out, k<1 zoom in

  // XR
  enterVR: () => Promise<void>
  enterAR: () => Promise<void>

  // Focus
  setExplode: (t: number) => void               // 0 overview; 1 exploded
  setOrbitTargetTo: (index: number | null) => void
  isolateIndex: (i: number | null, dimOpacity?: number) => void // kept for other effects (unused by sections now)
  partCount: () => number
  getPartNames: () => string[]

  // Animation surface (compat)
  getAnimations: () => string[]
  playAnimation: (name?: string, fadeSeconds?: number, loopMode?: 'once'|'repeat'|'pingpong') => string | null
  stopAnimation: () => void
  pauseAnimation: () => void
  resumeAnimation: () => void
  setAnimationSpeed: (speed: number) => void

  // Bloom controls
  setBloom: (opts: { enabled?: boolean; threshold?: number; strength?: number; radius?: number }) => void
}

// ---------- Scene globals
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null

// NOTE: use `any` so TS2709 doesn't block builds for example classes
let controls: any = null
let composer: any = null
let renderPass: any = null
let bloomPass: any = null
let outputPass: any = null

let hBlurPass: any = null
let vBlurPass: any = null
let blurAmountPx = 0

let pmrem: THREE.PMREMGenerator | null = null
let autoRotateEnabled = true
let mountEl: HTMLElement | null = null

// XR helpers
let xrRefSpace: XRReferenceSpace | null = null
let xrHitSource: XRHitTestSource | null = null
let reticle: THREE.Mesh | null = null

// Studio backdrop
let studioBackdrop: THREE.Mesh | null = null

// ---------- Model / parts state (kept for isolate/focus)
let currentModel: THREE.Object3D | null = null
let parts: THREE.Object3D[] = []
let partNames: string[] = []
const savedMatProps = new WeakMap<THREE.Material, { transparent: boolean; opacity: number }>()
let bbox = new THREE.Box3()
let centroid = new THREE.Vector3()

// Target interpolation (for OrbitControls.target)
let target_desired = new THREE.Vector3()
const TARGET_LERP = 0.18 // smoothing per-frame

// ---------- Animation mixer (GLB-driven)
let mixer: THREE.AnimationMixer | null = null
let actions: Record<string, THREE.AnimationAction> = {}
let activeAction: THREE.AnimationAction | null = null
let clipNames: string[] = []
let clipDurations: Record<string, number> = {}
let playbackSpeed = 1.0
// Track whether we are logically at "overview (0)" or "exploded (1)"
let explodeState: 0 | 1 = 0

// ===== Smooth zoom config for exploded view =====
const EXPLODED_ZOOM_FACTOR = 1.30  // amount (1.25–1.40 typical)
const EXPLODED_ZOOM_MS = 420       // duration in ms

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

function dollyScaleSmooth(k: number, ms = 420) {
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

// Smooth zoom helpers used by exploded/overview transitions
function applyExplodedZoom() {
  if (_explodedZoomApplied) return
  dollyScaleSmooth(EXPLODED_ZOOM_FACTOR, EXPLODED_ZOOM_MS) // smooth zoom out
  _explodedZoomApplied = true
}
function clearExplodedZoom() {
  if (!_explodedZoomApplied) return
  dollyScaleSmooth(1 / EXPLODED_ZOOM_FACTOR, EXPLODED_ZOOM_MS) // smooth zoom back
  _explodedZoomApplied = false
}

// ---------- Helpers
function createReticle() {
  const ringGeo = new THREE.RingGeometry(0.09, 0.1, 32).rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({ color: 0x66bbff })
  const m = new THREE.Mesh(ringGeo, mat)
  m.visible = false
  return m
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
  const geo = new THREE.SphereGeometry(50, 64, 64)
  const mat = new THREE.MeshStandardMaterial({
    color: 0xababab, roughness: 1.0, metalness: 0.0, side: THREE.BackSide
  })
  const mesh = new THREE.Mesh(geo, mat)
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

// One-time fit (used on load only; we won’t move camera again on section changes)
function fitCameraToObject(obj: THREE.Object3D, padding = 1.2) {
  if (!camera || !controls) return
  const box = new THREE.Box3().setFromObject(obj)
  if (!isFinite(box.min.x) || !isFinite(box.max.x)) return
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = THREE.MathUtils.degToRad(camera.fov)
  const dist = (maxDim / (2 * Math.tan(fov / 2))) * padding

  // Keep current azimuth/elevation; move along current view dir
  const viewDir = new THREE.Vector3()
    .subVectors(camera.position, controls.target)
    .normalize()
  if (!isFinite(viewDir.length())) viewDir.set(0, 0, 1)

  camera.position.copy(center).add(viewDir.multiplyScalar(dist))
  camera.near = Math.max(0.01, dist / 100)
  camera.far = Math.max(camera.near * 10, dist * 50)
  camera.updateProjectionMatrix()

  controls.target.copy(center)
  controls.update()
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

// Clone once, remember baseline opacity (never 0)
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
    if (Array.isArray(o.material)) {
      o.material = o.material.map(wrap)
    } else if (o.material) {
      o.material = wrap(o.material)
    }
  })
}

function computeModelStats(root: THREE.Object3D) {
  bbox.setFromObject(root)
  bbox.getCenter(centroid)
}

// Soft isolate (kept for compatibility; not used by section flow)
function isolatePart(index: number | null, dimOpacity = 0.01) {
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

// Utility: world position by object name
function getWorldPosByName(name: string, out = new THREE.Vector3()): THREE.Vector3 | null {
  if (!scene) return null
  const obj = scene.getObjectByName(name)
  if (!obj) return null
  obj.updateWorldMatrix(true, false)
  out.setFromMatrixPosition(obj.matrixWorld)
  return out
}

// Utility: zoom by multiplicative scale factor around controls.target (immediate)
function dollyScale(k: number) {
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
}

// Visibility mask: null => all visible; list => only those indices visible
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

// ---------- Public init
export async function initViewer(container: HTMLElement, opts: InitOptions = {}): Promise<ViewerHandle> {
  mountEl = container

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  const dprCap = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 1.5 : 2
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap))

  // Canvas element must obey container bounds exactly
  container.appendChild(renderer.domElement)
  const cvs = renderer.domElement as HTMLCanvasElement
  cvs.style.position = 'absolute'
  cvs.style.inset = '0'
  cvs.style.width = '100%'
  cvs.style.height = '100%'
  cvs.style.display = 'block'

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

  renderer.setClearColor(0xffffff, 1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = opts.toneMappingExposure ?? 1.0
  renderer.shadowMap.enabled = !!opts.enableShadows
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.xr.enabled = true

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

  // Backdrop + shadow ground
  addStudioBackdrop()

  // PostFX (single pipeline)
  composer = new EffectComposer(renderer)
  renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)

  // Optional global blur (off by default)
  hBlurPass = new ShaderPass(HorizontalBlurShader)
  vBlurPass = new ShaderPass(VerticalBlurShader)
  hBlurPass.enabled = false
  vBlurPass.enabled = false
  composer.addPass(hBlurPass)
  composer.addPass(vBlurPass)

  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    opts.bloomStrength ?? 0.18,
    opts.bloomRadius ?? 0.22,
    opts.bloomThreshold ?? 0.8
  )
  bloomPass.enabled = opts.bloomEnabled ?? true
  composer.addPass(bloomPass)

  outputPass = new OutputPass()
  composer.addPass(outputPass)

  // Reticle
  reticle = createReticle()
  scene.add(reticle)

  // Controls
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.enablePan = false
  controls.enableZoom = false
  controls.autoRotate = autoRotateEnabled
  controls.autoRotateSpeed = 0
  controls.minDistance = 0.15
  controls.maxDistance = 20000
  controls.maxPolarAngle = Math.PI * 0.5

  // Animate
  const clock = new THREE.Clock()
  const renderFrame = () => {
    const dt = clock.getDelta()

    // smooth target (OrbitControls.target -> desired)
    if (controls) {
      const lerpAmt = 1 - Math.pow(1 - TARGET_LERP, dt * 60)
      controls.target.lerp(target_desired, lerpAmt)
      controls.update()
    }

    if (mixer) mixer.update(dt * playbackSpeed)

    if (renderer?.xr?.isPresenting) {
      renderer.render(scene!, camera!)
    } else if (composer) {
      composer.render()
    } else {
      renderer?.render(scene!, camera!)
    }
  }
  renderer.setAnimationLoop(renderFrame)

  // Load initial model (uses Vite BASE_URL-safe path)
  await loadGLB(opts.modelUrl ?? DEFAULT_MODEL_URL)

  // Ensure initial desired target = current center
  target_desired.copy(centroid)

  return {
    setOrbitTargetByName: (name: string | null, _zoomScale = 1.0) => {
      if (!controls) return false
      if (!name) {
        target_desired.copy(centroid)
        return true
      }
      const pos = getWorldPosByName(name)
      if (!pos) return false
      target_desired.copy(pos)
      return true
    },

    setVisibleIndices: (indices: number[] | null) => {
      applyVisibilityMask(indices)
    },

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
      if (_zoomAnimRAF !== null) { cancelAnimationFrame(_zoomAnimRAF); _zoomAnimRAF = null }
      _explodedZoomApplied = false

      ro.disconnect?.()
      window.removeEventListener('orientationchange', sizeToContainer)
      window.visualViewport?.removeEventListener('resize', sizeToContainer)
      window.visualViewport?.removeEventListener('scroll', sizeToContainer)

      if (renderer) renderer.setAnimationLoop(null)
      if (composer) { composer = null; renderPass = null; bloomPass = null; outputPass = null }

      if (studioBackdrop) {
        studioBackdrop.geometry?.dispose?.()
        ;(studioBackdrop.material as any)?.dispose?.()
        scene?.remove(studioBackdrop)
        studioBackdrop = null
      }

      if (renderer) { renderer.dispose(); renderer = null }
      if (mixer) { mixer.stopAllAction(); mixer = null }
      actions = {}; activeAction = null; clipNames = []; clipDurations = {}
      controls?.dispose(); controls = null
      pmrem?.dispose(); pmrem = null
      scene = null; camera = null; currentModel = null; reticle = null
      parts = []; partNames = []
      explodeState = 0
    },

    // Studio
    setExposure: (expo: number) => { if (renderer) renderer.toneMappingExposure = expo },
    setAutoRotate: (enabled: boolean) => { autoRotateEnabled = enabled; if (controls) controls.autoRotate = enabled },
    resetView: () => {
      if (!controls) return
      controls.target.copy(centroid)
      target_desired.copy(centroid)
    },
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
      if (!navigator.xr) { alert('WebXR not available in this browser.'); return }
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] })
      await (renderer.xr as any).setSession(session)
    },
    enterAR: async () => {
      if (!renderer) return
      if (!navigator.xr) { alert('WebXR not available in this browser.'); return }
      const sessionInit: XRSessionInit = {
        requiredFeatures: ['hit-test', 'local-floor'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: mountEl! }
      } as any
      const session = await navigator.xr.requestSession('immersive-ar', sessionInit)
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
    },

    // Explosion controller (state-aware)
    // t=0 => overview (first frame, clamped)
    // t=1 => exploded (last frame, clamped)
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

      // Optional scrub (0 < t < 1)
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
    isolateIndex: (i: number | null, dimOpacity = 0.01) => isolatePart(i, dimOpacity),
    partCount: () => parts.length,
    getPartNames: () => [...partNames],

    // Animation API (compat)
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
      // actions use timeScale ±1; overall speed comes from mixer.update(dt * playbackSpeed)
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

// ---------- Load GLB
async function loadGLB(fileOrUrl: File | string) {
  if (!scene) return

  // stop any running zoom animation and reset flag
  if (_zoomAnimRAF !== null) { cancelAnimationFrame(_zoomAnimRAF); _zoomAnimRAF = null }
  _explodedZoomApplied = false

  // Clear previous model
  if (currentModel) {
    scene.remove(currentModel)
    currentModel.traverse((n: any) => {
      if (n.isMesh) {
        n.geometry?.dispose?.()
        if (Array.isArray(n.material)) n.material.forEach((m: any) => m.dispose?.())
        else n.material?.dispose?.()
      }
    })
    currentModel = null
  }
  if (mixer) { mixer.stopAllAction(); mixer = null }
  actions = {}; activeAction = null; clipNames = []; clipDurations = {}
  parts = []; partNames = []
  explodeState = 0

  const loader = new GLTFLoader()
  try {
    const draco = new DRACOLoader()
    draco.setDecoderPath(DRACO_PATH) // /draco/
    loader.setDRACOLoader(draco)
  } catch {
    console.warn('DRACOLoader not available; ensure /public/draco decoders if needed.')
  }

  const url = (typeof fileOrUrl === 'string') ? fileOrUrl : URL.createObjectURL(fileOrUrl)

  await new Promise<void>((resolve, reject) => {
    loader.load(
      url,
      (gltf: any) => {
        const root = gltf.scene || (gltf.scenes && gltf.scenes[0])
        if (!root) {
          console.error('GLTF has no scene.')
          reject(new Error('GLTF has no scene'))
          return
        }
        currentModel = root

        // Mesh setup
        root.traverse((obj: any) => {
          if (obj.isMesh) {
            obj.castShadow = true
            obj.receiveShadow = true
          }
        })

        // Clone materials once (records baseline opacity)
        cloneMaterials(root)
        normalizeImportedLights(root)

        // Parts for isolate/focus
        parts = gatherParts(root)
        partNames = parts.map((p, i) => p.name || `Part ${i + 1}`)

        // Stats
        computeModelStats(root)

        // Scene add
        scene!.add(root)

        // One-time fit to view
        fitCameraToObject(root, 1.25)

        // Animations (GLB-driven explosion)
        if (gltf.animations && gltf.animations.length) {
          mixer = new THREE.AnimationMixer(root)
          gltf.animations.forEach((clip: THREE.AnimationClip, i: number) => {
            const name = clip.name?.length ? clip.name : `Clip_${i}`
            const action = mixer!.clipAction(clip)
            action.enabled = true
            action.setLoop(THREE.LoopOnce, 0)  // one-shot
            action.clampWhenFinished = true
            action.reset()                      // at t=0 pose
            action.paused = true                // wait for setExplode(1)
            action.setEffectiveWeight(1)
            action.setEffectiveTimeScale(1)
            actions[name] = action
            clipNames.push(name)
            clipDurations[name] = clip.duration
          })
          // Ensure initial rest pose is visible and state = overview
          mixer.update(1e-6)
          explodeState = 0
        } else {
          console.warn('No animations found in GLB.')
        }

        if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url as string)
        resolve()
      },
      undefined,
      (err) => {
        console.error('[GLTFLoader] failed', err)
        reject(err)
      }
    )
  })
}
