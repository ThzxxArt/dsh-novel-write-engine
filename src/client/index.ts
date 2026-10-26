import { PANEL_ID } from '../constants.js'
import { NovelIcon, NovelPanel } from './panel.js'

/** The subset of the browser context this half needs; kept structural on purpose. */
export interface ClientContext {
  effect?: (body: () => undefined | (() => void), label?: string) => void
  slots: {
    inject: (name: string, body: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: (props: never) => unknown) => unknown
  }
}

export const name = 'dsh-novel-write-engine'
export const inject = ['slots']

/**
 * Register the sidebar entry and the main page. The sidebar id must equal the
 * `main` key; that pairing is what makes the icon open this page.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: 'novel-workshop',
      },
      NovelPanel as (props: never) => unknown,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => '网文工坊',
        locale: 'novel-workshop',
      },
      NovelIcon as unknown as (props: never) => unknown,
    ),
  )
}

export { NovelPanel, NovelIcon }
