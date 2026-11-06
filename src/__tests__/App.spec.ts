import { describe, it, expect } from 'vitest'

import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import App from '../App.vue'

describe('App', () => {
  it('renders the selected route through the application host', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/capture', component: { template: '<main>Capture workspace</main>' } }],
    })
    await router.push('/capture')
    await router.isReady()
    const wrapper = mount(App, { global: { plugins: [router] } })
    expect(wrapper.find('main').text()).toBe('Capture workspace')
    wrapper.unmount()
  })
})
