import { QueryClient, QueryCache } from "@tanstack/react-query";
import { AuthError } from "../api";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof AuthError) {
        window.dispatchEvent(new CustomEvent("auth:expired"));
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof AuthError) return false;
        return failureCount < 2;
      },
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});
