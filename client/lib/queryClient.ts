import { QueryClient, type DefaultOptions } from "@tanstack/react-query";

const queryConfig: DefaultOptions = {
  queries: {
    queryFn: async ({ queryKey }) => {
      const res = await fetch(queryKey[0] as string, {
        credentials: 'include',
      });

      if (!res.ok) {
        if (res.status >= 500) {
          throw new Error(`${res.status}: ${res.statusText}`);
        }

        const text = await res.text();
        let message;
        try {
          const json = JSON.parse(text);
          message = json.message;
        } catch (e) {
          message = text;
        }

        throw new Error(`${res.status}: ${message}`);
      }

      return res.json();
    },
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  },
};

export const queryClient = new QueryClient({ defaultOptions: queryConfig });

export async function apiRequest(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    if (res.status >= 500) {
      throw new Error(`${res.status}: ${res.statusText}`);
    }

    const text = await res.text();
    let message;
    try {
      const json = JSON.parse(text);
      message = json.message;
    } catch (e) {
      message = text;
    }

    throw new Error(`${res.status}: ${message}`);
  }

  return res;
}
