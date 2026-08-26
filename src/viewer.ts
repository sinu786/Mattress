// src/viewer.mobile.ts — soft soft-shadow mobile build (VSM + shadow catcher)
// - Force-centers any GLB by wrapping in a pivot at the origin
// - Touch rotate works (explicit touchAction + touches mapping)
// - Section names: promote inner "sec N" node names to their parent parts so App.tsx can detect sections
// - Canvas strictly follows the mount's visible bounds (ResizeObserver + visualViewport)
// - High-quality soft shadows (VSM when WebGL2 available, fallback PCFSoft)
// - Translucent ShadowMaterial catcher + overlays provide contact shadows
// - Radial reveal (ring) that fades materials in by alpha, with ripple

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
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js'
import { color } from 'three/examples/jsm/nodes/Nodes.js'
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js'


// ---- Program cache key guard ----
(() => {
  const FLAG = Symbol('safeCacheKeyPatched')

  const safeStr = (v: any) => {
    try { return typeof v === 'function' ? String(v) : '' }
    catch { return '' }
  }

  const decorate = (proto: any) => {
    if (!proto || proto[FLAG]) return
    const orig = typeof proto.customProgramCacheKey === 'function'
      ? proto.customProgramCacheKey
      : null

    proto.customProgramCacheKey = function customProgramCacheKeySafe() {
      let base = ''
      try {
        base = orig ? String(orig.call(this) ?? '') : ''
      } catch { /* ignore */ }

      const obc = safeStr(this && this.onBeforeCompile)
      const flags = []
      if (this?.userData?.__revealPatched) flags.push('reveal')
      if (this?.depthWrite === false)      flags.push('dw0')
      if (this?.userData?.__sssPatched)    flags.push('sss')

      return `${base}|${obc}|${flags.join(',')}`
    }

    proto[FLAG] = true
  }

  decorate((THREE as any).Material?.prototype)
  decorate((THREE as any).MeshStandardMaterial?.prototype)
  decorate((THREE as any).MeshPhysicalMaterial?.prototype)
  decorate((THREE as any).ShaderMaterial?.prototype)
})()

// --- LiftGammaGain + Warmth shader ---
const LggWarmthShader = {
  uniforms: {
    uSaturation: { value: 1.0 },
    uVibrance:   { value: 0.0 },
    uContrast:   { value: 1.0 },
    tDiffuse:    { value: null },
    uLift:       { value: new THREE.Vector3(0, 0, 0) },
    uGamma:      { value: new THREE.Vector3(1, 1, 1) },
    uGain:       { value: new THREE.Vector3(1, 1, 1) },
    uWarmth:     { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }
  `,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec3 uLift, uGamma, uGain;
    uniform float uWarmth, uSaturation, uVibrance, uContrast;

    float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    vec3 applyLGG(vec3 c){
      c = c + uLift;
      c = max(c, vec3(0.0));
      c = pow(c, uGamma);
      c = c * uGain;
      return c;
    }
    vec3 applyWarmth(vec3 c){
      vec3 w = vec3(1.0 + 0.08*uWarmth, 1.0, 1.0 - 0.08*uWarmth);
      return c * w;
    }
    vec3 applySaturation(vec3 c){
      float Y = luma(c);
      return mix(vec3(Y), c, uSaturation);
    }
    vec3 applyVibrance(vec3 c){
      float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
      float amt = uVibrance * (1.0 - sat);
      float Y = luma(c);
      return mix(vec3(Y), c, 1.0 + amt);
    }
    vec3 applyContrast(vec3 c){
      c = (c - 0.5) * uContrast + 0.5;
      return max(c, 0.0);
    }

    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = applyLGG(c);
      c = applyWarmth(c);
      c = applySaturation(c);
      c = applyVibrance(c);
      c = applyContrast(c);
      gl_FragColor = vec4(c, 1.0);
    }
  `
}

// ===== Radial Reveal =====
const REVEAL_DURATION_MS = 1000
const REVEAL_SOFTNESS    = 0.24
const REVEAL_RIPPLE_AMP  = 0.06
const REVEAL_RIPPLE_FREQ = 6.0
const REVEAL_SPEED       = 1.0
let keyLight: THREE.DirectionalLight | null = null

type SSSOpts = { color?: number|string; strength?: number; wrap?: number; power?: number; thickness?: number }
const _sssUniformPools: any[] = []
let _sssEnabled = false
const _tmpLPos = new THREE.Vector3()
const _tmpLTgt = new THREE.Vector3()
const _tmpLDir = new THREE.Vector3()


let bokehPass: any = null
let targetAperture = 0.00001 // Deep focus default
const MACRO_APERTURE = 0.015 // The shallow DOF limit you liked from the test


let revealActive = false
let revealStartT = 0
let revealMaxR   = 1
let revealCenterW = new THREE.Vector3()

const BASE = (import.meta as any).env?.BASE_URL ?? '/'
const DEFAULT_MODEL_URL = `${BASE}assets/bed_proxy.glb`
const DRACO_PATH = `${BASE}draco/`

const SHADOW_BASE_OPACITY   = 0.5
const SHADOW_CORE_OPACITY   = 0
const SHADOW_CORE_SCALE     = 0
const SHADOW_FEATHER_OPAC   = 0
const SHADOW_FEATHER_INNER  = 0
const SHADOW_FEATHER_OUTER  = 0

let lggPass: any = null
const INITIAL_FRAME_PADDING = 1.3
const INITIAL_ZOOM_FACTOR   = 1.5

export type InitOptions = {
  groundStyle?: 'full' | 'invisible'
  reflectOpacity?: number
  lightRig?: 'mobile' | 'none'
  envIntensity?: number
  backdropColor?: number | string
  useACES?: boolean
  enableShadows?: boolean
  shadowOpacity?: number
  shadowMapSize?: number
  scrollScrub?: boolean
  modelUrl?: string
  hdriUrl?: string
  showHDRIBackground?: boolean
  toneMappingExposure?: number
  bloomEnabled?: boolean
  bloomThreshold?: number
  bloomStrength?: number
  bloomRadius?: number
  toneInit?: {
    exposure?: number
    lift?: [number, number, number]
    gamma?: [number, number, number]
    gain?: [number, number, number]
    warmth?: number
    saturation?: number
    vibrance?: number
    contrast?: number
    curve?: 'ACES' | 'Reinhard' | 'Linear' | 'Cineon' | 'None'
  }
}

export type ToneOpts = {
  exposure?: number
  lift?: [number, number, number]
  gamma?: [number, number, number]
  gain?: [number, number, number]
  warmth?: number
  saturation?: number
  vibrance?: number
  contrast?: number
  curve?: 'ACES' | 'Reinhard' | 'Linear' | 'Cineon' | 'None'
}

export type ViewerHandle = {
  setRotateEnabled?: (enabled: boolean) => void
  setTone: (opts: ToneOpts) => void
  
  // Notice the three arguments here now:
  setOrbitTargetByName: (name: string | null, customPadding?: number, snapBack?: boolean) => boolean
  setOrbitTargetTo: (index: number | null, customPadding?: number, snapBack?: boolean) => void
  
  setBlur: (amountPx: number) => void
  setVisibleIndices: (indices: number[] | null) => void
  loadGLB: (fileOrUrl: File | string, onProgress?: (percent: number) => void) => Promise<void>
  dispose: () => void
  setExposure: (expo: number) => void
  setAutoRotate: (enabled: boolean) => void
  resetView: () => void
  dolly?: (k: number) => void
  enterVR: () => Promise<void>
  enterAR: () => Promise<void>
  setExplode: (t: number) => void
  isolateIndex: (i: number | null, dimOpacity?: number) => void
  partCount: () => number
  getPartNames: () => string[]
  getAnimations: () => string[]
  playAnimation: (name?: string, fadeSeconds?: number, loopMode?: 'once'|'repeat'|'pingpong') => string | null
  stopAnimation: () => void
  pauseAnimation: () => void
  resumeAnimation: () => void
  setAnimationSpeed: (speed: number) => void
  setBloom: (opts: { enabled?: boolean; threshold?: number; strength?: number; radius?: number }) => void
}


let initOpts: InitOptions = {}
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: any = null
let groundGroup: THREE.Group | null = null
let groundMirror: any = null
let groundFilm: THREE.Mesh | null = null
let groundFade: THREE.Mesh | null = null
let shadowCatcher: THREE.Mesh | null = null

let composer: any = null
let renderPass: any = null
let bloomPass: any = null
let outputPass: any = null
let hBlurPass: any = null
let vBlurPass: any = null
let blurAmountPx = 0
let modelSpinEnabled = false
let modelSpinSpeed = 0.2

let pmrem: THREE.PMREMGenerator | null = null
let autoRotateEnabled = true
let mountEl: HTMLElement | null = null

let pivot: THREE.Group | null = null
let currentModel: THREE.Object3D | null = null
let parts: THREE.Object3D[] = []
let partNames: string[] = []
const savedMatProps = new WeakMap<THREE.Material, { transparent: boolean; opacity: number }>()
let bbox = new THREE.Box3()
let centroid = new THREE.Vector3()

let target_desired = new THREE.Vector3()
let camera_desired = new THREE.Vector3()
let target_velocity = new THREE.Vector3()
let camera_velocity = new THREE.Vector3()
let is_camera_snapping = false 

const SPRING_TENSION = 350.0
const SPRING_FRICTION = 40.0

let xrRefSpace: XRReferenceSpace | null = null
let xrHitSource: XRHitTestSource | null = null
let reticle: THREE.Mesh | null = null
let studioBackdrop: THREE.Mesh | null = null

let mixer: THREE.AnimationMixer | null = null
let actions: Record<string, THREE.AnimationAction> = {}
let activeAction: THREE.AnimationAction | null = null
let clipNames: string[] = []
let clipDurations: Record<string, number> = {}
let playbackSpeed = 1.0
let explodeState: 0 | 1 = 0

const EXPLODED_ZOOM_FACTOR = 1.2
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

function _applyRevealToRoot(root: THREE.Object3D, softDist: number) {
  root.traverse((o: any) => {
    if (!o.isMesh || !o.material) return
    const patch = (mat: any) => {
      _injectRevealShader(mat)
      const u = mat.userData?.__revealUniforms
      if (u) { u.uSoft.value = softDist }
      mat.needsUpdate = true
    }
    if (Array.isArray(o.material)) o.material.forEach(patch)
    else patch(o.material)
  })
}

function _updateReveal(root: THREE.Object3D, tNow: number) {
  const t = Math.min(1, (tNow - revealStartT) / Math.max(1, REVEAL_DURATION_MS))
  const r = revealMaxR * (t * REVEAL_SPEED)
  const timePhase = t * Math.PI * 2.0

  let anyMat = false
  root.traverse((o: any) => {
    if (!o.isMesh || !o.material) return
    const upd = (mat: any) => {
      const u = mat.userData?.__revealUniforms
      if (!u) return
      anyMat = true
      u.uCenter.value.copy(revealCenterW)
      u.uR.value = r
      u.uTime.value = timePhase
    }
    if (Array.isArray(o.material)) o.material.forEach(upd)
    else upd(o.material)
  })

  return !(t >= 1 || !anyMat)
}

function _removeReveal(root: THREE.Object3D) {
  root.traverse((o: any) => {
    if (!o.isMesh || !o.material) return
    const restore = (mat: any) => {
      if (!mat.userData?.__revealPatched) return
      const clean = mat.clone()
      delete (clean as any).onBeforeCompile
      if (clean.userData) {
        delete clean.userData.__revealPatched
        delete clean.userData.__revealUniforms
        delete clean.userData.__revealDefaults
      }
      const saved = savedMatProps.get(mat)
      if (saved) {
        (clean as any).transparent = saved.transparent
        ;(clean as any).opacity = saved.opacity
        ;(clean as any).depthWrite = true
      }
      o.material = clean
      mat.dispose?.()
    }
    if (Array.isArray(o.material)) {
      o.material = o.material.map((m: any) => {
        const c = m.clone()
        delete (c as any).onBeforeCompile
        return c
      })
      o.material.forEach(restore)
    } else {
      restore(o.material)
    }
  })
}

function fitDirLightShadowToBBox(light: THREE.DirectionalLight, box: THREE.Box3) {
  const s = Math.max(box.getSize(new THREE.Vector3()).x, box.getSize(new THREE.Vector3()).z) * 0.8
  const cam = light.shadow.camera as THREE.OrthographicCamera
  cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s
  cam.near = 0.1; cam.far = Math.max(10, box.getSize(new THREE.Vector3()).y * 4)
  cam.updateProjectionMatrix()
  light.shadow.needsUpdate = true
}

function updateGroundHeightFromBBox() {
  if (!scene || !groundGroup) return
  const target = pivot || currentModel || scene
  const box = new THREE.Box3().setFromObject(target)
  if (!isFinite(box.min.y) || !isFinite(box.max.y)) return
  const newY = Math.min(box.min.y, groundBaseY) - GROUND_PAD
  if (groundMirror) (groundMirror as any).position.y = newY
  if (shadowCatcher) shadowCatcher.position.y        = newY + 0.00012
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

function polishPBRMaterials(root: THREE.Object3D) {
  root.traverse((o: any) => {
    if (!o.isMesh) return
    const tune = (m: any) => {
      if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
        m.roughness = THREE.MathUtils.clamp(m.roughness ?? 0.6, 0.38, 0.85)
        m.metalness = Math.min(m.metalness ?? 0.02, 0.35)
        if ('sheen' in m) m.sheen = Math.min(m.sheen ?? 0.0, 0.15)
        if ('clearcoat' in m) m.clearcoat = Math.min(m.clearcoat ?? 0.06, 0.09)
        if ('clearcoatRoughness' in m) m.clearcoatRoughness = Math.max(m.clearcoatRoughness ?? 0.7, 0.65)
        if ('envMapIntensity' in m) m.envMapIntensity = initOpts.envIntensity ?? 0.35
      }
    }
    if (Array.isArray(o.material)) o.material.forEach(tune)
    else if (o.material) tune(o.material)
  })
}

function addMobileLightRig() {
  if (!scene) return
  const useShadows = !!(initOpts.enableShadows)

  // 1. Hemisphere: Soft ambient base (slightly dialed back so directional lights pop)
  const hemi = new THREE.HemisphereLight(0xfffdfa, 0xe8e3dc, 0.35)
  hemi.position.set(0, 1, 0)
  scene.add(hemi)

  // 2. Key Light: Stronger, positioned lower to rake across the mattress tufting
  const key = new THREE.DirectionalLight(0xffffff, 1.8) // Increased intensity
  key.position.set(3.5, 1.4, 1.5) // Shallower angle for grazing shadows
  key.color.setRGB(1.0, 0.97, 0.92) // Soft warm champagne
  keyLight = key 
  scene.add(key)

  if (useShadows) {
    key.castShadow = true
    const sms = initOpts.shadowMapSize ?? 1024
    key.shadow.mapSize.set(sms, sms)
    key.shadow.camera.near = 0.1
    key.shadow.camera.far = 25
    key.shadow.camera.left = -8
    key.shadow.camera.right = 8
    key.shadow.camera.top = 8
    key.shadow.camera.bottom = -8
 
    
    // Tightened biases to prevent floating shadows
    key.shadow.normalBias = 0.015 
    key.shadow.bias = -0.0005
    ;(key.shadow as any).radius = 10 // Reduced blur radius for better ground contact
  }

  // 3. Rim Light: Softened to create an elegant edge without blowing out
  const rim = new THREE.DirectionalLight(0xffffff, 0.5) // Reduced from 3.0
  rim.position.set(-3.0, 1.5, -3.5)
  rim.color.setRGB(1.2, 1, .5) // Neutral/very slight cool white
  rim.castShadow = false
  scene.add(rim)

  // 4. Fill Light: Lowered intensity, moved slightly off-center
  const fill = new THREE.DirectionalLight(0xffffff, 0.2) // Reduced from 0.5
  fill.position.set(-1.5, 0.8, 3.0) 
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
  const col = (initOpts.backdropColor ?? 0xF5E2C1) as any

  const geo = new THREE.SphereGeometry(50, 64, 64)
  const mat = new THREE.MeshStandardMaterial({ 
    color: col, 
    roughness: 1, 
    metalness: 0, 
    side: THREE.BackSide,
    envMapIntensity: 1
  })
  const mesh = new THREE.Mesh(geo, mat)
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

function computeModelStats(obj: THREE.Object3D) { bbox.setFromObject(obj); bbox.getCenter(centroid) }

function gatherParts(root: THREE.Object3D): THREE.Object3D[] {
  const set = new Set<THREE.Object3D>()
  root.children.forEach(ch => {
    let hasMesh = false
    ch.traverse(o => { if ((o as any).isMesh) hasMesh = true })
    if (hasMesh) set.add(ch)
  })
  if (set.size === 0) {
    root.traverse(o => { const m: any = o; if (m.isMesh && o.parent) set.add(o.parent) })
  }
  return Array.from(set)
}

function promoteSectionNamesToParts(partsArr: THREE.Object3D[]) {
  const rx = /^(?:\s*(?:sec|se|section)\s*)(\d+)\s*$/i
  partsArr.forEach(p => {
    let chosen: string | null = null
    if (typeof p.name === 'string' && rx.test(p.name.trim())) { chosen = p.name }
    else {
      p.traverse(o => { if (chosen) return; const n = (o.name || '').trim(); if (n && rx.test(n)) chosen = n })
    }
    if (chosen) p.name = chosen
  })
}

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
  // --- TRIGGER DOF ---
  // If an index is provided (zooming into a layer), open the aperture.
  // If null (Overview/Exploded), close the aperture to 0.00001.
  targetAperture = (index !== null) ? MACRO_APERTURE : 0.00001

  const dim = Math.max(0.08, Math.min(0.5, dimOpacity))
  parts.forEach((p, i) => {
    p.visible = true
    p.traverse((o: any) => {
      if (!o.isMesh) return
      const apply = (m: THREE.Material) => {
        const saved = savedMatProps.get(m)
        const base = saved?.opacity ?? 1
        ;(m as any).transparent = true
        
        // When isolated, push unselected layers to dim
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

function centerRootUnderPivot(root: THREE.Object3D) {
  if (!scene) return
  if (!pivot) { pivot = new THREE.Group(); pivot.name = 'Pivot'; scene.add(pivot) }
  else { while (pivot.children.length) pivot.remove(pivot.children[0]) }

  const box = new THREE.Box3().setFromObject(root)
  const c = new THREE.Vector3(); box.getCenter(c)
  root.position.sub(c); root.updateMatrixWorld(true)

  pivot.add(root)
  currentModel = pivot
  centroid.set(0, 0, 0)
}

// ---------- Public init
export async function initViewer(container: HTMLElement, opts: InitOptions = {}): Promise<ViewerHandle> {
  initOpts = { lightRig: 'mobile', envIntensity: 0.02, backdropColor: 0xF5E2C1, useACES: true, enableShadows: false, groundStyle: 'invisible', ...opts }
  mountEl = container

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true, preserveDrawingBuffer: false })
  renderer.outputColorSpace = THREE.SRGBColorSpace as any
  renderer.toneMapping = (opts.useACES ?? true) ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping
  renderer.toneMappingExposure = (initOpts.toneMappingExposure ?? 1)

  if (initOpts.enableShadows) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = (renderer.capabilities.isWebGL2 ? THREE.VSMShadowMap : THREE.PCFSoftShadowMap) as any
  }

  const dprCap = 2
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap))
  container.appendChild(renderer.domElement)
  const cvs = renderer.domElement as HTMLCanvasElement
  cvs.style.position = 'absolute'; cvs.style.inset = '0'; cvs.style.width = '100%'; cvs.style.height = '100%'; cvs.style.display = 'block'
  ;(cvs.style as any).touchAction = 'none'

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

  const ro = new ResizeObserver(sizeToContainer)
  ro.observe(container)
  window.addEventListener('orientationchange', sizeToContainer)
  if ((window as any).visualViewport) {
    ;(window as any).visualViewport.addEventListener('resize', sizeToContainer)
    ;(window as any).visualViewport.addEventListener('scroll', sizeToContainer)
  }

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xffffff)
  camera = new THREE.PerspectiveCamera(35, 1, 0.01, 20000)
  camera.position.set(1.5, 1, 3)
  scene.add(camera)

  if (opts.hdriUrl) { try { await loadHDRIToEnv(opts.hdriUrl, !!opts.showHDRIBackground) } catch (e) { console.warn('HDRI load failed, using RoomEnvironment', e) } }
  if (!scene.environment) {
    pmrem = new THREE.PMREMGenerator(renderer)
    const env = new RoomEnvironment()
    const envTex = pmrem.fromScene(env, 0.04).texture
    scene.environment = envTex
    if (opts.showHDRIBackground) scene.background = envTex
  }

  addStudioBackdrop()

  if ((initOpts.lightRig ?? 'mobile') !== 'none') addMobileLightRig()

  composer = new EffectComposer(renderer)

  renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)


  // --- STATIC MACRO DOF TEST ---
  bokehPass = new BokehPass(scene!, camera!, {
    focus: 1,       // The fixed focal plane distance (tweak this to hit the mattress)
    aperture: 0.015,  // Cranked up for a very shallow depth of field
    maxblur: 0.025,   // Allows for a creamier, wider blur on out-of-focus areas
    width: container.clientWidth,
    height: container.clientHeight
  })
  composer.addPass(bokehPass)


  lggPass = new ShaderPass(LggWarmthShader)
  composer.addPass(lggPass)

  if (initOpts.toneInit) {
    const t = initOpts.toneInit
    if (t.curve) {
      renderer.toneMapping =
        t.curve === 'ACES'     ? THREE.ACESFilmicToneMapping :
        t.curve === 'Reinhard' ? THREE.ReinhardToneMapping :
        t.curve === 'Cineon'   ? THREE.CineonToneMapping :
        t.curve === 'Linear'   ? THREE.LinearToneMapping :
                                 THREE.NoToneMapping
    }
    if (typeof t.exposure   === 'number') renderer.toneMappingExposure = t.exposure
    if (t.lift)   lggPass.uniforms.uLift.value.set(...t.lift)
    if (t.gamma)  lggPass.uniforms.uGamma.value.set(...t.gamma)
    if (t.gain)   lggPass.uniforms.uGain.value.set(...t.gain)
    if (typeof t.warmth     === 'number') lggPass.uniforms.uWarmth.value     = t.warmth
    if (typeof t.saturation === 'number') lggPass.uniforms.uSaturation.value = t.saturation
    if (typeof t.vibrance   === 'number') lggPass.uniforms.uVibrance.value   = t.vibrance
    if (typeof t.contrast   === 'number') lggPass.uniforms.uContrast.value   = t.contrast
  }

  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1),
    initOpts.bloomStrength ?? 0.15,
    initOpts.bloomRadius   ?? 0.01,
    initOpts.bloomThreshold?? 0.9
  )
  bloomPass.enabled = opts.bloomEnabled ?? true
  composer.addPass(bloomPass)

  const vignettePass = new ShaderPass(VignetteShader)
  vignettePass.uniforms['offset'].value = 1.1
  vignettePass.uniforms['darkness'].value = 1.0
  composer.addPass(vignettePass)

  outputPass = new OutputPass()
  composer.addPass(outputPass)

  sizeToContainer()

  reticle = createReticle()
  scene.add(reticle)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.dampingFactor = 0.12
  controls.enablePan = false
  controls.enableZoom = false
  controls.enableRotate = true
  // Explicitly map single touch to rotate so mobile users can orbit smoothly
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
  controls.autoRotate = autoRotateEnabled
  controls.autoRotateSpeed = 0
  controls.minDistance = 0.15
  controls.maxDistance = 20000
  controls.maxPolarAngle = Math.PI * 0.5

  // Instantly release the camera animation to the user when they grab/touch the model
  controls.addEventListener('start', () => {
    is_camera_snapping = false
  })

  const clock = new THREE.Clock()
  const renderFrame = () => {
    if (revealActive && pivot) {
      const keepGoing = _updateReveal(pivot, performance.now())
      if (!keepGoing) {
        revealActive = false
        _removeReveal(pivot)
        if (controls) controls.autoRotate = autoRotateEnabled
      }
    }

    const dt = Math.min(clock.getDelta(), 0.05) 

    if (controls) { 
      const tDiff = new THREE.Vector3().subVectors(target_desired, controls.target)
      target_velocity.add(tDiff.multiplyScalar(SPRING_TENSION * dt))
      target_velocity.multiplyScalar(Math.exp(-SPRING_FRICTION * dt))
      controls.target.addScaledVector(target_velocity, dt)

      if (is_camera_snapping && camera) {
        const cDiff = new THREE.Vector3().subVectors(camera_desired, camera.position)
        camera_velocity.add(cDiff.multiplyScalar(SPRING_TENSION * dt))
        camera_velocity.multiplyScalar(Math.exp(-SPRING_FRICTION * dt))
        camera.position.addScaledVector(camera_velocity, dt)
        
        if (cDiff.lengthSq() < 0.001 && camera_velocity.lengthSq() < 0.001) {
          is_camera_snapping = false
        }
      }
      controls.update() 
    }

    if (mixer) mixer.update(dt * playbackSpeed)
    if (modelSpinEnabled && pivot) pivot.rotation.y += modelSpinSpeed * dt
    if (groundFollow) updateGroundHeightFromBBox()
      if (bokehPass && camera && controls) {
        // 1. Calculate actual distance from the camera to the orbit target
        const focalDistance = camera.position.distanceTo(controls.target)
        
        // 2. Smoothly lerp focus distance (Auto-focusing)
        bokehPass.uniforms.focus.value += (focalDistance - bokehPass.uniforms.focus.value) * 0.1
        
        // 3. Smoothly lerp aperture (Rack focus transition)
        bokehPass.uniforms.aperture.value += (targetAperture - bokehPass.uniforms.aperture.value) * 0.08
      }


    if ((renderer as any)?.xr?.isPresenting) {
      renderer!.render(scene!, camera!)
    } else if (composer) {
      composer.render()
    } else {
      renderer!.render(scene!, camera!)
    }
  }

  if (_sssEnabled && keyLight && _sssUniformPools.length) {
    keyLight.updateMatrixWorld(true)
    keyLight.target.updateMatrixWorld(true)
    _tmpLPos.setFromMatrixPosition(keyLight.matrixWorld)
    _tmpLTgt.setFromMatrixPosition(keyLight.target.matrixWorld)
    _tmpLDir.copy(_tmpLPos).sub(_tmpLTgt).normalize()
    for (let i = 0; i < _sssUniformPools.length; i++) {
      const u = _sssUniformPools[i]
      if (u?.uLightDir) u.uLightDir.value.copy(_tmpLDir)
    }
  }

  renderer.setAnimationLoop(renderFrame)

  await loadGLB(opts.modelUrl ?? DEFAULT_MODEL_URL)
  target_desired.copy(centroid)

  return { 
    setRotateEnabled: (enabled: boolean) => {
      if (controls) controls.enableRotate = enabled
    },

    setTone: (opts) => {
      if (!renderer || !lggPass) return
      if (opts.curve) {
        renderer.toneMapping =
          opts.curve === 'ACES'     ? THREE.ACESFilmicToneMapping :
          opts.curve === 'Reinhard' ? THREE.ReinhardToneMapping :
          opts.curve === 'Cineon'   ? THREE.CineonToneMapping :
          opts.curve === 'Linear'   ? THREE.LinearToneMapping :
                                      THREE.NoToneMapping
      }
      if (typeof opts.exposure === 'number') renderer.toneMappingExposure = opts.exposure
      if (opts.lift)  lggPass.uniforms.uLift.value.set(...opts.lift)
      if (opts.gamma) lggPass.uniforms.uGamma.value.set(...opts.gamma)
      if (opts.gain)  lggPass.uniforms.uGain.value.set(...opts.gain)
      if (typeof opts.warmth === 'number') lggPass.uniforms.uWarmth.value = opts.warmth
    },
    setOrbitTargetByName: (name: string | null, customPadding?: number, snapBack = false) => { 
      if (!controls || !camera) return false
      
      const obj = name ? scene?.getObjectByName(name) : pivot
      if (!obj) return false

      const targetBox = new THREE.Box3().setFromObject(obj)
      const targetCenter = new THREE.Vector3()
      targetBox.getCenter(targetCenter)
      target_desired.copy(targetCenter)

      const size = new THREE.Vector3()
      targetBox.getSize(size)
      const maxDim = Math.max(size.x, size.y, size.z) 
      const fov = THREE.MathUtils.degToRad(camera.fov)
      
      const padding = customPadding !== undefined ? customPadding : (name ? 1.1 : INITIAL_FRAME_PADDING)
      const idealDist = (maxDim / (2 * Math.tan(fov / 2))) * padding

      // SNAP BACK LOGIC: Use the initial camera angle (1.5, 1, 3) if snapBack is true
      const baseDir = new THREE.Vector3(1.5, 1, 3).normalize()
      const currentDir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize()
      const dir = snapBack ? baseDir : currentDir
      
      if (!isFinite(dir.length()) || dir.lengthSq() < 0.01) dir.set(0, 0, 1)

      camera_desired.copy(targetCenter).add(dir.multiplyScalar(idealDist))
      is_camera_snapping = true
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
        groundGroup.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.() })
        scene?.remove(groundGroup)
        groundGroup = null; groundMirror = null; groundFilm = null; groundFade = null; shadowCatcher = null 
      }
      if (_zoomAnimRAF !== null) { cancelAnimationFrame(_zoomAnimRAF); _zoomAnimRAF = null }
      _explodedZoomApplied = false
      ro.disconnect?.()
      window.removeEventListener('orientationchange', sizeToContainer)
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
        const sessionInit: XRSessionInit = { requiredFeatures: ['hit-test', 'local-floor'], optionalFeatures: ['dom-overlay'], domOverlay: { root: mountEl! } } as any
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
    setExplode: (t: number) => {
      if (!mixer || !Object.keys(actions).length) return
      t = THREE.MathUtils.clamp(t, 0, 1)
      if (t <= 0) {
        if (explodeState === 1) {
          Object.entries(actions).forEach(([name, a]) => { 
            const dur = clipDurations[name] ?? a.getClip().duration
            a.enabled = true; a.setLoop(THREE.LoopOnce, 0); a.clampWhenFinished = true; a.reset()
            a.setEffectiveWeight(1); a.setEffectiveTimeScale(-1); a.time = Math.max(0, dur - 1e-6); a.paused = false; a.play() 
          })
        } else {
          Object.values(actions).forEach(a => { 
            a.enabled = true; a.setLoop(THREE.LoopOnce, 0); a.clampWhenFinished = true; a.reset()
            a.paused = true; a.setEffectiveWeight(1); a.setEffectiveTimeScale(1); a.time = 0 
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
            a.enabled = true; a.setLoop(THREE.LoopOnce, 0); a.clampWhenFinished = true; a.reset()
            a.paused = true; a.setEffectiveWeight(1); a.setEffectiveTimeScale(1); a.time = dur 
          })
          mixer.update(1e-6)
        } else {
          Object.values(actions).forEach(a => { 
            a.enabled = true; a.setLoop(THREE.LoopOnce, 0); a.clampWhenFinished = true; a.reset()
            a.setEffectiveWeight(1); a.setEffectiveTimeScale(1); a.paused = false; a.play() 
          })
        }
        applyExplodedZoom()
        explodeState = 1
        return
      }
      Object.entries(actions).forEach(([name, a]) => { 
        const dur = clipDurations[name] ?? a.getClip().duration
        a.enabled = true; a.play(); a.paused = true; a.setEffectiveWeight(1); a.time = dur * t 
      })
      mixer.update(0)
    },
    setOrbitTargetTo: (index: number | null, customPadding?: number, snapBack = false) => { 
      if (!controls || !camera) return
      
      let obj: THREE.Object3D | null = null
      if (index === null || index < 0 || index >= parts.length) { 
        obj = pivot 
      } else { 
        obj = parts[index] 
      }
      if (!obj) return

      const targetBox = new THREE.Box3().setFromObject(obj)
      const targetCenter = new THREE.Vector3()
      targetBox.getCenter(targetCenter)
      target_desired.copy(targetCenter)

      const size = new THREE.Vector3()
      targetBox.getSize(size)
      const maxDim = Math.max(size.x, size.y, size.z)
      const fov = THREE.MathUtils.degToRad(camera.fov)
      
      const padding = customPadding !== undefined ? customPadding : (index === null ? INITIAL_FRAME_PADDING : 1.1)
      const idealDist = (maxDim / (2 * Math.tan(fov / 2))) * padding

      // SNAP BACK LOGIC
      const baseDir = new THREE.Vector3(1.5, 1, 3).normalize()
      const currentDir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize()
      const dir = snapBack ? baseDir : currentDir

      if (!isFinite(dir.length()) || dir.lengthSq() < 0.01) dir.set(0, 0, 1)

      camera_desired.copy(targetCenter).add(dir.multiplyScalar(idealDist))
      is_camera_snapping = true
    },
    isolateIndex: (i: number | null, dimOpacity = 0.22) => isolatePart(i, dimOpacity),
    partCount: () => parts.length,
    getPartNames: () => [...partNames],
    getAnimations: () => [...clipNames],
    playAnimation: (name?: string, fadeSeconds = 0.25, loopMode: 'once'|'repeat'|'pingpong' = 'repeat'): string | null => { 
      if (!mixer || clipNames.length === 0) return null
      const target = name && actions[name] ? name : clipNames[0]
      const next = actions[target]
      if (!next) return null
      if (loopMode === 'once') { next.setLoop(THREE.LoopOnce, 0); next.clampWhenFinished = true } 
      else if (loopMode === 'pingpong') { next.setLoop(THREE.LoopPingPong, Infinity); next.clampWhenFinished = false } 
      else { next.setLoop(THREE.LoopRepeat, Infinity); next.clampWhenFinished = false }
      if (activeAction && activeAction !== next) { activeAction.crossFadeTo(next.reset().play(), fadeSeconds, false) } 
      else { next.reset().fadeIn(fadeSeconds).play() }
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

let groundBaseY = 0
let groundFollow = true
const GROUND_PAD = 0

function addReflectiveGround(y: number) {
  if (!scene || !renderer) return

  if (groundGroup) {
    groundGroup.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.() })
    scene.remove(groundGroup)
  }
  groundGroup = new THREE.Group()
  scene.add(groundGroup)

  const radius = 40
  const segs = 128

  shadowCatcher = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 1, segs),
    new THREE.ShadowMaterial({ opacity: SHADOW_BASE_OPACITY, color: 0x826F5C })
  )
  shadowCatcher.rotateX(-Math.PI / 2)
  shadowCatcher.position.set(0, y + 0.00012, 0)
  shadowCatcher.receiveShadow = true
  const sm = shadowCatcher.material as THREE.ShadowMaterial
  sm.transparent = true
  sm.polygonOffset = true
  sm.polygonOffsetFactor = 1
  sm.polygonOffsetUnits = 1
  shadowCatcher.renderOrder = 1
  groundGroup.add(shadowCatcher)

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(radius * SHADOW_CORE_SCALE, segs),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true,
      uniforms: { uOpacity: { value: SHADOW_CORE_OPACITY } },
      vertexShader: `
        varying vec2 vUv; void main(){
          vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv; uniform float uOpacity;
        void main(){
          vec2 p = vUv*2.0-1.0;
          float d = length(p);
          float a = 1.0 - smoothstep(0.0, 1.0, d);
          gl_FragColor = vec4(0.0,0.0,0.0, a * uOpacity);
        }`
    })
  )
  core.rotateX(-Math.PI / 2)
  core.position.set(0, y + 0.00013, 0)
  core.renderOrder = 2
  groundGroup.add(core)

  const feather = new THREE.Mesh(
    new THREE.CircleGeometry(radius, segs),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true,
      uniforms: {
        uOpacity: { value: SHADOW_FEATHER_OPAC },
        uInner:   { value: SHADOW_FEATHER_INNER },
        uOuter:   { value: SHADOW_FEATHER_OUTER },
      },
      vertexShader: `
        varying vec2 vUv; void main(){
          vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv; uniform float uOpacity, uInner, uOuter;
        void main(){
          vec2 p = vUv*2.0-1.0;
          float d = length(p);
          float ring = smoothstep(uInner, uOuter, d) * (1.0 - smoothstep(uOuter-0.02, uOuter, d));
          gl_FragColor = vec4(0.0,0.0,0.0, ring * uOpacity);
        }`
    })
  )
  feather.rotateX(-Math.PI / 2)
  feather.position.set(0, y + 0.00014, 0)
  feather.renderOrder = 3
  groundGroup.add(feather)

  groundFilm = core
  groundFade = feather
}

async function loadGLB(fileOrUrl: File | string, onProgress?: (percent: number) => void) {
  if (!scene) return
  if (_zoomAnimRAF !== null) { cancelAnimationFrame(_zoomAnimRAF); _zoomAnimRAF = null }
  _explodedZoomApplied = false

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
    draco.setDecoderPath('/draco/')
    loader.setDRACOLoader(draco) 
    console.log('DRACO load complete')
  } catch (err) { 
    console.warn('DRACOLoader not available; loading without it.', err) 
  }

  const url = (typeof fileOrUrl === 'string') ? fileOrUrl : URL.createObjectURL(fileOrUrl)

  await new Promise<void>((resolve, reject) => {
    loader.load(
      url,
      (gltf: any) => {
        const root = gltf.scene || (gltf.scenes && gltf.scenes[0])
        if (!root) { reject(new Error('GLTF has no scene')); return }

        root.traverse((obj: any) => {
          if (obj.isMesh) {
            if (initOpts.enableShadows) { obj.castShadow = true; obj.receiveShadow = true } 
            else { obj.castShadow = false; obj.receiveShadow = false }
          }
        })

        cloneMaterials(root)
        polishPBRMaterials(root)
        normalizeImportedLights(root)
        setEnvIntensity(root, initOpts.envIntensity ?? 1.15)

        centerRootUnderPivot(root)
        scene!.add(pivot!)

        parts = gatherParts(root)
        promoteSectionNamesToParts(parts)
        partNames = parts.map((p, i) => p.name || `Part ${i + 1}`)

        computeModelStats(pivot!)
        if (scene) {
          const dl = scene.children.find((o: any) => o.isDirectionalLight) as THREE.DirectionalLight | undefined
          if (dl) fitDirLightShadowToBBox(dl, bbox)
        }

        fitCameraToObject(pivot!, INITIAL_FRAME_PADDING)

        if (REVEAL_DURATION_MS > 0) {
          revealCenterW.set(0, 0, 0)
          if (pivot) pivot.localToWorld(revealCenterW.set(0, 0, 0))

          const size = new THREE.Vector3()
          bbox.getSize(size)
          revealMaxR = 0.5 * Math.sqrt(size.x * size.x + size.y * size.y + size.z * size.z)

          const softDist = REVEAL_SOFTNESS * revealMaxR
          _applyRevealToRoot(root, softDist)

          root.traverse((o: any) => {
            if (!o.isMesh) return
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            mats.forEach((mat: any) => {
              const u = mat.userData?.__revealUniforms
              if (u) { u.uCenter.value.copy(revealCenterW); u.uR.value = 1e-3; u.uTime.value = 0.0 }
            })
          })

          if (controls) controls.autoRotate = false
          revealActive = true
          revealStartT = performance.now()
        }

        if (INITIAL_ZOOM_FACTOR !== 1.5) dollyScaleSmooth(INITIAL_ZOOM_FACTOR, 0)

        if (gltf.animations && gltf.animations.length) {
          mixer = new THREE.AnimationMixer(root)
          gltf.animations.forEach((clip: THREE.AnimationClip, i: number) => {
            const name = clip.name?.length ? clip.name : `Clip_${i}`
            const action = mixer!.clipAction(clip)
            action.enabled = true; action.setLoop(THREE.LoopOnce, 0); action.clampWhenFinished = true; action.reset()
            action.paused = true; action.setEffectiveWeight(1); action.setEffectiveTimeScale(1)
            actions[name] = action; clipNames.push(name); clipDurations[name] = clip.duration
          })
          mixer.update(1e-6)
          explodeState = 0
        }

        if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url as string)
        resolve()
      },
      (xhr) => {
        if (xhr.total > 0 && onProgress) {
          const percent = (xhr.loaded / xhr.total) * 100
          onProgress(percent)
        }
      },
      (err) => { console.error('[GLTFLoader] failed', err); reject(err) }
    )
  })

  groundBaseY = bbox.min.y - GROUND_PAD
  addReflectiveGround(groundBaseY)
}


function _injectRevealShader(m: any) {
  if (!m || m.userData?.__revealPatched) return

  m.userData ??= {}
  m.userData.__revealPatched = true
  m.userData.__revealDefaults = m.userData.__revealDefaults || {
    uSoft: 1.0,
    uAmp: REVEAL_RIPPLE_AMP,
    uFreq: REVEAL_RIPPLE_FREQ,
  }

  m.onBeforeCompile = (shader: any) => {
    shader.uniforms.uCenter = { value: revealCenterW.clone() }
    shader.uniforms.uR      = { value: 0.0 }
    shader.uniforms.uSoft   = { value: m.userData.__revealDefaults.uSoft }
    shader.uniforms.uAmp    = { value: m.userData.__revealDefaults.uAmp }
    shader.uniforms.uFreq   = { value: m.userData.__revealDefaults.uFreq }
    shader.uniforms.uTime   = { value: 0.0 }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(transformed,1.0)).xyz;')

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPos;\nuniform vec3 uCenter;\nuniform float uR, uSoft, uAmp, uFreq, uTime;`)

    const EDGE_CODE = `
      float d = length(vWorldPos - uCenter);
      float ripple = sin(d * uFreq - uTime) * uAmp;
      float edge = 1.0 - smoothstep(uR - uSoft + ripple, uR + uSoft + ripple, d);
    `

    if (shader.fragmentShader.includes('#include <output_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <output_fragment>',
        `
          ${EDGE_CODE}
          gl_FragColor = vec4( outgoingLight, diffuseColor.a * edge );
        `
      )
    } else {
      shader.fragmentShader = shader.fragmentShader.replace('void main() {', `void main() {\n${EDGE_CODE}`)
      shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', 'gl_FragColor = vec4( outgoingLight, diffuseColor.a * edge );')
    }

    m.userData.__revealUniforms = shader.uniforms
  }

  m.transparent = true
  m.depthWrite  = true
  ;(m as any).alphaTest = 0.0
  m.blending = THREE.NormalBlending
  m.needsUpdate = true
}

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
  controls.target.copy(center)
  controls.update()
}
