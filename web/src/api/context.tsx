import { createContext, useContext } from "react";
import type { ApiClient } from "../types";

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("ApiContext is not available");
  return client;
}
