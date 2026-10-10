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
  ],
})

export default router
