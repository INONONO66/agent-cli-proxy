import { useEffect, useState } from "react";

export interface RouteInfo {
  page: string;
  param: string | null;
  hash: string;
}

function parseHash(hash: string): RouteInfo {
  const normalized = hash || "#/";
  const path = normalized.replace("#", "");
  const [, page = "", param] = path.split("/");
  return { page: page || "overview", param: param || null, hash: normalized };
}

export function useRoute(): RouteInfo {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    function onHashChange() {
      setRoute(parseHash(window.location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

export function navigate(hash: string) {
  window.location.hash = hash;
}
