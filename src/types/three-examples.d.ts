declare module 'three/examples/jsm/*';

// Basic ambient typings for Three examples & GLTF loader
declare module 'three/examples/jsm/controls/OrbitControls.js' {
    import { Camera, EventDispatcher, Vector3 } from 'three'
    export class OrbitControls extends EventDispatcher {
      constructor(object: Camera, domElement?: HTMLElement)
      enabled: boolean
      target: Vector3
      minDistance: number
      maxDistance: number
      maxPolarAngle: number
      enableDamping: boolean
      dampingFactor: number
      enablePan: boolean
      enableZoom: boolean
      autoRotate: boolean
      autoRotateSpeed: number
      update(): boolean
      dispose(): void
    }
  }
  
  declare module 'three/examples/jsm/postprocessing/EffectComposer.js' {
    import { WebGLRenderer, WebGLRenderTarget } from 'three'
    export class EffectComposer {
      constructor(renderer: WebGLRenderer, target?: WebGLRenderTarget)
      addPass(pass: any): void
      setSize(width: number, height: number): void
      render(): void
      dispose?(): void
    }
  }
  
  declare module 'three/examples/jsm/postprocessing/RenderPass.js' {
    import { Scene, Camera } from 'three'
    export class RenderPass {
      constructor(scene: Scene, camera: Camera)
    }
  }
  
  declare module 'three/examples/jsm/postprocessing/UnrealBloomPass.js' {
    import { Vector2 } from 'three'
    export class UnrealBloomPass {
      constructor(resolution: Vector2, strength?: number, radius?: number, threshold?: number)
      enabled: boolean
      strength: number
      radius: number
      threshold: number
      setSize(width: number, height: number): void
    }
  }
  
  declare module 'three/examples/jsm/postprocessing/OutputPass.js' {
    export class OutputPass { constructor() {} }
  }
  
  declare module 'three/examples/jsm/loaders/GLTFLoader.js' {
    import { Loader, LoadingManager, AnimationClip, Object3D } from 'three'
    export interface GLTF { scene: Object3D; scenes: Object3D[]; animations: AnimationClip[] }
    export class GLTFLoader extends Loader {
      constructor(manager?: LoadingManager)
      load(url: string, onLoad: (gltf: GLTF) => void, onProgress?: (e: ProgressEvent) => void, onError?: (e: ErrorEvent) => void): void
      loadAsync(url: string, onProgress?: (e: ProgressEvent) => void): Promise<GLTF>
      setDRACOLoader(loader: any): void
    }
  }
  
  declare module 'three/examples/jsm/loaders/DRACOLoader.js' {
    import { Loader } from 'three'
    export class DRACOLoader extends Loader {
      setDecoderPath(path: string): DRACOLoader
    }
  }
  
  declare module 'three/examples/jsm/loaders/RGBELoader.js' {
    import { Loader, Texture } from 'three'
    export class RGBELoader extends Loader {
      loadAsync(url: string): Promise<Texture>
    }
  }
  
  declare module 'three/examples/jsm/environments/RoomEnvironment.js' {
    import { Scene } from 'three'
    export class RoomEnvironment extends Scene { constructor() { super() } }
  }
  