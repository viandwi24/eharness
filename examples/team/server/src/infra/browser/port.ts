/**
 * The browser as the app sees it (`BrowserPort`, `app/ports.ts`): `eharness/browser` objects behind
 * app-owned structural types, so `app/` and `http/` never import the library.
 */
import { formatHandBack } from 'eharness/browser'
import type { BrowserPort } from '../../app/ports.ts'
import type { BrowserService } from './index.ts'

export function createBrowserPort(service: BrowserService): BrowserPort {
  const { registry, manager } = service
  return {
    driver: service.config.driver,
    max: service.config.max,
    profiles: service.profiles,
    adapters: () => registry.list(),
    adapter: (id) => registry.get(id),
    forms: (id) => registry.forms(id),
    validate: (id, mode, settings) => registry.validate(id, mode, settings),
    merge: (id, mode, stored, patch) => registry.merge(id, mode, stored, patch),
    publicProfile: (profile) => registry.publicProfile(profile),
    capabilities: (profile) => manager.capabilities(profile),
    leases: () => manager.status(),
    start: (id) => manager.start(id),
    stop: (id) => manager.stop(id),
    test: (target) => manager.test(target),
    usage: () => manager.usage(),
    live: (id, viewer) => manager.live(id, viewer),
    onChange: (listener) => manager.on((e) => listener({ profileId: e.profileId, type: e.type })),
    formatHandBack: (info) => formatHandBack(info),
    runtimes: () => service.runtimes(),
    info: () => service.info(),
  }
}
