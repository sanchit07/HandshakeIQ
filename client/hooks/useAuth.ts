import { useQuery } from "@tanstack/react-query";

export function useAuth() {
  const { data: user, isLoading, error } = useQuery({
    queryKey: ["/api/auth/user"],
    retry: false,
    // Don't treat 401 or null response as an error - it just means guest mode
    throwOnError: false,
  });

  // User is in guest mode if:
  // 1. Not loading AND
  // 2. No user data (null response or 401)
  const isGuest = !isLoading && !user;
  const isAuthenticated = !isLoading && !!user;

  return {
    user,
    isLoading,
    isAuthenticated,
    isGuest,
  };
}
