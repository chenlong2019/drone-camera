/**
 * Small, renderer agnostic adapter for previewing a reconstructed 3D Tileset.
 *
 * Cesium is deliberately injected by the host.  Keeping this class free of a
 * Cesium import means it can be used from a worker or tested with plain
 * objects, while a Cesium application can pass `Cesium3DTileset.fromUrl`
 * (or an object exposing `fromUrl`/`load`) as the loader.
 */

export type ReconstructionPreviewCompareMode = 'original' | 'reconstructed' | 'both'

export interface ReconstructionPrimitiveCollection<T> {
  add(primitive: T): T
  remove(primitive: T): boolean
}

export interface ReconstructionPreviewViewer<T = unknown> {
  scene?: {
    primitives?: ReconstructionPrimitiveCollection<T>
  }
}

export interface ReconstructionTilesetLoader<T> {
  /** A generic loader used by tests and non-Cesium hosts. */
  load?: (url: string) => Promise<T> | T
  /** Cesium3DTileset.fromUrl compatible entry point. */
  fromUrl?: (url: string) => Promise<T> | T
}

export type ReconstructionTilesetLoaderInput<T> =
  | ReconstructionTilesetLoader<T>
  | ((url: string) => Promise<T> | T)

export interface ReconstructionPreviewOptions<TTileset, TOriginal = unknown> {
  viewer: ReconstructionPreviewViewer<TTileset>
  loader: ReconstructionTilesetLoaderInput<TTileset>
  /** Existing scene primitive(s) used for the original/reconstructed comparison. */
  original?: TOriginal | readonly TOriginal[]
  compareMode?: ReconstructionPreviewCompareMode
  visible?: boolean
}

export interface ReconstructionPreviewState<TTileset, TOriginal = unknown> {
  url: string | null
  tileset: TTileset | null
  original: TOriginal | readonly TOriginal[] | undefined
  compareMode: ReconstructionPreviewCompareMode
  visible: boolean
  destroyed: boolean
}

type Showable = { show?: boolean }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asShowable(value: unknown): Showable | null {
  return isObject(value) ? (value as Showable) : null
}

function setShow(value: unknown, visible: boolean): void {
  const showable = asShowable(value)
  if (showable) showable.show = visible
}

function forEachOriginal<T>(original: T | readonly T[] | undefined, callback: (value: T) => void): void {
  if (Array.isArray(original)) {
    const values = original as readonly T[]
    values.forEach((value) => callback(value))
  } else if (original !== undefined) {
    callback(original as T)
  }
}

function loaderFunction<T>(loader: ReconstructionTilesetLoaderInput<T>): (url: string) => Promise<T> | T {
  if (typeof loader === 'function') return loader
  if (typeof loader.fromUrl === 'function') return loader.fromUrl.bind(loader)
  if (typeof loader.load === 'function') return loader.load.bind(loader)
  throw new TypeError('A tileset loader function, fromUrl, or load method is required')
}

/**
 * Manage one reconstructed primitive and an optional original primitive set.
 * The original primitives are owned by the caller and are never removed or
 * destroyed by this class.
 */
export class ReconstructionPreview<TTileset, TOriginal = unknown> {
  readonly viewer: ReconstructionPreviewViewer<TTileset>
  readonly loader: (url: string) => Promise<TTileset> | TTileset
  private readonly primitives: ReconstructionPrimitiveCollection<TTileset>
  private original: TOriginal | readonly TOriginal[] | undefined
  private currentTileset: TTileset | null = null
  private currentUrl: string | null = null
  private compareMode: ReconstructionPreviewCompareMode
  private visible: boolean
  private destroyed = false
  private loadVersion = 0
  private readonly originalVisibility = new Map<Showable, { hadShow: boolean; show: boolean | undefined }>()

  constructor(options: ReconstructionPreviewOptions<TTileset, TOriginal>) {
    if (!options || !options.viewer) throw new TypeError('A viewer is required')
    const primitives = options.viewer.scene?.primitives
    if (!primitives || typeof primitives.add !== 'function' || typeof primitives.remove !== 'function') {
      throw new TypeError('viewer.scene.primitives with add/remove methods is required')
    }
    this.viewer = options.viewer
    this.primitives = primitives
    this.loader = loaderFunction(options.loader)
    this.original = options.original
    this.compareMode = options.compareMode ?? 'both'
    this.visible = options.visible ?? true
    this.rememberOriginalVisibility()
    this.applyVisibility()
  }

  get tileset(): TTileset | null {
    return this.currentTileset
  }

  get url(): string | null {
    return this.currentUrl
  }

  get mode(): ReconstructionPreviewCompareMode {
    return this.compareMode
  }

  get isVisible(): boolean {
    return this.visible
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }

  get state(): ReconstructionPreviewState<TTileset, TOriginal> {
    return {
      url: this.currentUrl,
      tileset: this.currentTileset,
      original: this.original,
      compareMode: this.compareMode,
      visible: this.visible,
      destroyed: this.destroyed,
    }
  }

  /** Load, mount, and return a tileset through the injected adapter. */
  async load(url: string): Promise<TTileset> {
    this.assertAlive()
    if (typeof url !== 'string' || !url.trim()) throw new TypeError('A non-empty tileset URL is required')
    const version = ++this.loadVersion

    // Resolve before removing the current result, so a transient network
    // failure does not make an already visible preview disappear.
    const loaded = await this.loader(url)
    if (loaded === null || loaded === undefined) throw new Error('Tileset loader returned no tileset')
    if (this.destroyed || version !== this.loadVersion) {
      if (loaded !== this.currentTileset) this.destroyPrimitive(loaded)
      throw new Error(this.destroyed ? 'ReconstructionPreview has been destroyed' : 'Tileset load was superseded')
    }

    const previous = this.currentTileset
    if (loaded !== previous) {
      try {
        this.primitives.add(loaded)
      } catch (error) {
        this.destroyPrimitive(loaded)
        throw error
      }
      this.currentTileset = loaded
      this.currentUrl = url
      if (previous !== null) this.unmount(previous)
    } else {
      this.currentUrl = url
    }
    this.applyVisibility()
    return loaded
  }

  /** Change which scene layers are shown. */
  setCompareMode(mode: ReconstructionPreviewCompareMode): void {
    this.assertAlive()
    if (mode !== 'original' && mode !== 'reconstructed' && mode !== 'both') {
      throw new RangeError(`Unknown reconstruction compare mode: ${String(mode)}`)
    }
    this.compareMode = mode
    this.applyVisibility()
  }

  /** Toggle the complete preview while preserving the compare mode. */
  setVisible(visible: boolean): void {
    this.assertAlive()
    this.visible = Boolean(visible)
    this.applyVisibility()
  }

  /** Replace the caller-owned original primitive used by comparison mode. */
  setOriginal(original: TOriginal | readonly TOriginal[] | undefined): void {
    this.assertAlive()
    this.restoreOriginalVisibility()
    this.original = original
    this.rememberOriginalVisibility()
    this.applyVisibility()
  }

  /** Remove and destroy the loaded reconstruction. Safe to call repeatedly. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.loadVersion += 1
    const loaded = this.currentTileset
    this.currentTileset = null
    this.currentUrl = null
    try {
      if (loaded !== null) this.unmount(loaded)
    } finally {
      this.restoreOriginalVisibility()
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('ReconstructionPreview has been destroyed')
  }

  private rememberOriginalVisibility(): void {
    forEachOriginal(this.original, (primitive) => {
      const showable = asShowable(primitive)
      if (showable && !this.originalVisibility.has(showable)) {
        this.originalVisibility.set(showable, { hadShow: 'show' in showable, show: showable.show })
      }
    })
  }

  private restoreOriginalVisibility(): void {
    for (const [primitive, original] of this.originalVisibility) {
      if (original.hadShow) primitive.show = original.show
      else delete primitive.show
    }
    this.originalVisibility.clear()
  }

  private applyVisibility(): void {
    const showOriginal = this.visible && (this.compareMode === 'original' || this.compareMode === 'both')
    const showReconstructed =
      this.visible && (this.compareMode === 'reconstructed' || this.compareMode === 'both')
    forEachOriginal(this.original, (primitive) => setShow(primitive, showOriginal))
    if (this.currentTileset !== null) setShow(this.currentTileset, showReconstructed)
  }

  private unmount(primitive: TTileset): void {
    setShow(primitive, false)
    try {
      this.primitives.remove(primitive)
    } finally {
      this.destroyPrimitive(primitive)
    }
  }

  private destroyPrimitive(primitive: unknown): void {
    if (!isObject(primitive)) return
    const isDestroyed = primitive.isDestroyed
    if (typeof isDestroyed === 'function' && isDestroyed.call(primitive)) return
    const destroy = primitive.destroy
    if (typeof destroy === 'function') destroy.call(primitive)
  }
}

export default ReconstructionPreview
