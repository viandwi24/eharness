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
    // headed Chrome on Linux needs DISPLAY or Xvfb; macOS and Windows always have a screen
    windows: service.config.xvfb || process.platform !== 'linux' || Boolean(process.env.DISPLAY),
    profiles: service.profiles,
    adapters: () => registry.list(),
    adapter: (id) => registry.get(id),
    forms: (id) => registry.forms(id),
    validate: (id, mode, settings) => registry.validate(id, mode, settings),
    merge: (id, mode, stored, patch) => registry.merge(id, mode, stored, patch),
    publicProfile: (profile) => registry.publicProfile(profile),
    capabilities: (profile) => manager.capabilities(profile),
    leases: () => manager.status(),
    start: async (id) => {
      const r = await manager.start(id)
      // the library names the fix in general terms; here it is a profile switch or an env var
      return !r.ok && r.error.includes('needs a display')
        ? {
            ok: false,
            error:
              'This server has no display, so Chrome can not run with a window. Turn Headless on in the profile settings (the live view works without a window), or start the server with TEAM_BROWSER_XVFB=1.',
          }
        : r
    },
    stop: (id) => manager.stop(id),
    test: (target) => manager.test(target),
    usage: () => manager.usage(),
    live: (id, viewer) => manager.live(id, viewer),
    onChange: (listener) => manager.on((e) => listener({ profileId: e.profileId, type: e.type })),
    formatHandBack: (info) => formatHandBack(info),
    runtimes: () => service.runtimes(),
    remoteRuntime: async () => (await service.remoteRuntime())?.runtime,
    info: () => service.info(),
  }
}
