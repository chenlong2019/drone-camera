/**
 * 解析 `public/` 下静态资源的 URL。
 *
 * 站点可能部署在根路径（本地 / Vercel）或子路径（GitHub Pages 的 `/drone-camera/`），
 * 直接写死 `/models/x.glb` 在子路径部署下会 404。统一走 Vite 注入的 `BASE_URL` 拼接。
 *
 * @param path 相对 `public/` 的路径，可带或不带前导斜杠
 */
export function assetUrl(path: string): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')
  return `${base}/${path.replace(/^\/+/, '')}`
}

/**
 * 幂等地往 `<head>` 注入一张样式表（用于 Cesium 的 widgets.css 这类不便静态 import 的资源）。
 *
 * 放在 CSS 里的 `@import url('/Cesium/...')` 在构建后无法被改写 base，故改为运行时注入。
 */
export function ensureStylesheet(href: string): void {
  if (typeof document === 'undefined') return
  const selector = `link[data-dc-href="${href}"]`
  if (document.querySelector(selector)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.dataset.dcHref = href
  document.head.appendChild(link)
}
