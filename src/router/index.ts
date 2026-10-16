import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/three-demo' },
    {
      path: '/three-demo',
      name: 'ThreeDemo',
      component: () => import('../views/three-demo/three-demo.vue'),
      meta: { title: '示例页面', menu: true },
    },
    {
      path: '/cesium-demo',
      name: 'CesiumDemo',
      component: () => import('../views/cesium-demo/cesium-demo.vue'),
      meta: { title: 'Cesium 初始场景', menu: true },
    },
    {
      path: '/docs',
      name: 'Docs',
      component: () => import('../views/docs/docs-view.vue'),
      meta: { title: '使用文档', menu: true },
    },
    {
      path: '/api-docs',
      name: 'ApiDocs',
      component: () => import('../views/api-docs/api-docs-view.vue'),
      meta: { title: 'API 参考', menu: true },
    },
  ],
})

export default router
