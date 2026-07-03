import { useEffect, useMemo, useState } from "react";

import { useAuthStore } from "../../auth/store/authStore";
import { listPlatformConnections } from "../api/platformConnectionApi";
import type { PlatformConnection } from "../../../shared/types/platformConnection";

export function useFacebookPageScope() {
  const activeAccountId = useAuthStore((state) => state.activeAccountId);
  const activeFacebookConnectionId = useAuthStore((state) => state.activeFacebookConnectionId);
  const setActiveFacebookConnectionId = useAuthStore((state) => state.setActiveFacebookConnectionId);

  const [connections, setConnections] = useState<PlatformConnection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!activeAccountId) {
      setConnections([]);
      setLoadingConnections(false);
      setConnectionError(null);
      setActiveFacebookConnectionId(null);
      return () => {
        cancelled = true;
      };
    }

    setLoadingConnections(true);
    listPlatformConnections()
      .then((response) => {
        if (cancelled) {
          return;
        }

        const facebookConnections = response.items.filter(
          (item) => item.platform_type === "facebook_page" && item.status === "connected",
        );
        setConnections(facebookConnections);
        setConnectionError(null);
        const currentConnectionId = useAuthStore.getState().activeFacebookConnectionId;
        setActiveFacebookConnectionId(
          facebookConnections.some((item) => item.id === currentConnectionId)
            ? currentConnectionId
            : (facebookConnections[0]?.id ?? null),
        );
      })
      .catch((err: any) => {
        if (cancelled) {
          return;
        }
        setConnections([]);
        setConnectionError(err.response?.data?.detail ?? "Unable to load Facebook Pages.");
        setActiveFacebookConnectionId(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingConnections(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeAccountId, setActiveFacebookConnectionId]);

  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === activeFacebookConnectionId) ?? null,
    [activeFacebookConnectionId, connections],
  );

  return {
    connections,
    loadingConnections,
    connectionError,
    activeFacebookConnectionId,
    activeConnection,
    hasMultipleConnections: connections.length > 1,
    setActiveFacebookConnectionId,
  };
}
