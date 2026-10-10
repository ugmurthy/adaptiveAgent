import type { BundledInstallCatalog } from './bundled-assets.js';

export const GENERATED_BUNDLED_INSTALL_CATALOG = {
  defaultBundles: [],
  bundles: {
    core: {
      agents: [],
      skills: [],
    },
  },
  agents: {},
  skills: {},
} satisfies BundledInstallCatalog;
