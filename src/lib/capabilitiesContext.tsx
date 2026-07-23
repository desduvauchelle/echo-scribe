import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { platformCapabilities, type PlatformCapabilities } from "./api";
import { DEFAULT_CAPS } from "./capabilities";

const CapabilitiesContext = createContext<PlatformCapabilities>(DEFAULT_CAPS);

export function PlatformCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [caps, setCaps] = useState<PlatformCapabilities>(DEFAULT_CAPS);

  useEffect(() => {
    let alive = true;
    platformCapabilities()
      .then((c) => {
        if (alive) setCaps(c);
      })
      .catch(() => {
        // Leave DEFAULT_CAPS in place; a failed probe hides macOS-only UI
        // rather than showing broken buttons.
      });
    return () => {
      alive = false;
    };
  }, []);

  return <CapabilitiesContext.Provider value={caps}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): PlatformCapabilities {
  return useContext(CapabilitiesContext);
}
